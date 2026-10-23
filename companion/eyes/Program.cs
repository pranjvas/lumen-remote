// Lumen Eyes: a windowless Tizen .NET app that lets Lumen see the TV screen. The Lumen TV agent
// launches it with app-control extra "lumen" = ws://<pc>:<port>/eyes?key=<key>; it dials out to that
// WebSocket and answers capture requests with one still each. Stills come from libdisplay-capture-api's
// ppicapture() (in-process: libvideo-capture → DRM ioctl on /dev/dri/card1); mode 0 is the composited
// screen, video plus the UI layer. Layouts were recovered from the emulator's library; see
// docs/research/re-eyes-dcapture.md.
//
// Protocol: text {t:'hello', version} on connect; text {t:'capture', id, mode?} → binary frame
// [4-byte big-endian header length][header JSON {t:'frame', id, ok, w, h, format:'nv12', ms}][Y w*h][UV w*h/2]
// or text {t:'frame', id, ok:false, error}; text {t:'bye'} → the app exits.
// Also: {t:'bluetooth', id} → adapter + bonded devices; {t:'procs', id} → memory, running apps, processes.
using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Net.WebSockets;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Threading.Tasks;
using Tizen.Applications;
using Tizen.Network.Bluetooth;

namespace LumenEyes
{
    static class Native
    {
        // int ppicapture(RequestedData*, unsigned char* ybuf, unsigned char* cbuf, int bufsize)
        [DllImport("libdisplay-capture-api.so.0", EntryPoint = "_Z10ppicaptureP13RequestedDataPhS1_i")]
        public static extern int PpiCapture(IntPtr data, IntPtr ybuf, IntPtr cbuf, int size);
    }

    class App : CoreUIApplication
    {
        const string Version = "0.3.2";
        const int BufSize = 0x7e900;              // the library's own buffer size; frames come back at 720x540
        const int GiveUpAfterMs = 10 * 60 * 1000; // exit when Lumen has been unreachable this long
        static readonly Regex LumenUrl = new Regex(@"^ws://[0-9.]{7,15}:\d{1,5}/eyes\?key=[0-9a-f]{16,128}$");

        readonly object gate = new object();
        string url;
        CancellationTokenSource current;
        // True while a connection to Lumen is open; a launch while not linked reconnects at once
        // instead of waiting out the backoff.
        volatile bool linked;
        IntPtr data, ybuf, cbuf;

        protected override void OnCreate()
        {
            base.OnCreate();
            data = Marshal.AllocHGlobal(0x80);
            ybuf = Marshal.AllocHGlobal(BufSize);
            cbuf = Marshal.AllocHGlobal(BufSize);
        }

        protected override void OnAppControlReceived(AppControlReceivedEventArgs e)
        {
            base.OnAppControlReceived(e);
            string next = null;
            try { e.ReceivedAppControl.ExtraData.TryGet("lumen", out next); } catch (Exception) { }
            if (next == null || !LumenUrl.IsMatch(next)) return;
            lock (gate)
            {
                if (next == url && current != null && !current.IsCancellationRequested && linked) return;
                current?.Cancel();
                url = next;
                current = new CancellationTokenSource();
                var token = current.Token;
                Task.Run(() => Serve(next, token));
            }
        }

        async Task Serve(string target, CancellationToken token)
        {
            var lastSeen = DateTime.UtcNow;
            int backoffMs = 1000;
            while (!token.IsCancellationRequested)
            {
                try
                {
                    using (var ws = new ClientWebSocket())
                    {
                        ws.Options.KeepAliveInterval = TimeSpan.FromSeconds(20);
                        await ws.ConnectAsync(new Uri(target), token);
                        backoffMs = 1000;
                        lastSeen = DateTime.UtcNow;
                        linked = true;
                        await SendText(ws, "{\"t\":\"hello\",\"version\":\"" + Version + "\"}", token);
                        var buffer = new byte[4096];
                        while (ws.State == WebSocketState.Open && !token.IsCancellationRequested)
                        {
                            var sb = new StringBuilder();
                            WebSocketReceiveResult r;
                            do
                            {
                                r = await ws.ReceiveAsync(new ArraySegment<byte>(buffer), token);
                                if (r.MessageType == WebSocketMessageType.Close) break;
                                sb.Append(Encoding.UTF8.GetString(buffer, 0, r.Count));
                            } while (!r.EndOfMessage && sb.Length <= 4096);
                            if (r.MessageType == WebSocketMessageType.Close) break;
                            lastSeen = DateTime.UtcNow;
                            string msg = sb.ToString();
                            string type = Field(msg, "t");
                            if (type == "bye") { Exit(); return; }
                            if (type == "capture") await Capture(ws, Field(msg, "id"), Number(Field(msg, "mode"), 0), token);
                            if (type == "bluetooth") await SendText(ws, BluetoothJson(Field(msg, "id")), token);
                            if (type == "procs") await SendText(ws, await ProcsJson(Field(msg, "id")), token);
                        }
                    }
                }
                catch (OperationCanceledException) { linked = false; return; }
                catch (Exception) { }
                linked = false;
                if ((DateTime.UtcNow - lastSeen).TotalMilliseconds > GiveUpAfterMs) { Exit(); return; }
                try { await Task.Delay(backoffMs, token); } catch (OperationCanceledException) { return; }
                backoffMs = Math.Min(backoffMs * 2, 30000);
            }
        }

        async Task Capture(ClientWebSocket ws, string id, int mode, CancellationToken token)
        {
            if (id == null || id.Length > 64 || mode < 0 || mode > 2)
            {
                await SendText(ws, "{\"t\":\"frame\",\"id\":" + Quote(id ?? "") + ",\"ok\":false,\"error\":\"bad request\"}", token);
                return;
            }
            int ret;
            var started = DateTime.UtcNow;
            // RequestedData: +0 width, +4 height (in/out), +8 0x20, +0xc ysize, +0x10 csize, +0x14 y*, +0x18 c*,
            // +0x1c mode, +0x20 0, +0x24 color format (in 2, out 1 = NV12), +0x28 (in 6).
            for (int i = 0; i < 0x80; i += 4) Marshal.WriteInt32(data, i, 0);
            Marshal.WriteInt32(data, 0x00, 720);
            Marshal.WriteInt32(data, 0x04, 540);
            Marshal.WriteInt32(data, 0x08, 0x20);
            Marshal.WriteInt32(data, 0x1c, mode);
            Marshal.WriteInt32(data, 0x24, 2);
            Marshal.WriteInt32(data, 0x28, 6);
            try { ret = Native.PpiCapture(data, ybuf, cbuf, BufSize); }
            catch (Exception ex)
            {
                await SendText(ws, "{\"t\":\"frame\",\"id\":" + Quote(id) + ",\"ok\":false,\"error\":" + Quote(ex.GetType().Name) + "}", token);
                return;
            }
            long ms = (long)(DateTime.UtcNow - started).TotalMilliseconds;
            int w = Marshal.ReadInt32(data, 0), h = Marshal.ReadInt32(data, 4), fmt = Marshal.ReadInt32(data, 0x24);
            IntPtr yp = Marshal.ReadIntPtr(data, 0x14), cp = Marshal.ReadIntPtr(data, 0x18);
            int ySize = w * h, cSize = w * h / 2;
            if (ret != 0 || w < 16 || h < 16 || ySize > BufSize || fmt != 1)
            {
                await SendText(ws, "{\"t\":\"frame\",\"id\":" + Quote(id) + ",\"ok\":false,\"error\":\"capture failed (" + ret + ", " + w + "x" + h + ", format " + fmt + ")\"}", token);
                return;
            }
            byte[] header = Encoding.UTF8.GetBytes("{\"t\":\"frame\",\"id\":" + Quote(id) + ",\"ok\":true,\"w\":" + w + ",\"h\":" + h + ",\"format\":\"nv12\",\"ms\":" + ms + "}");
            var frame = new byte[4 + header.Length + ySize + cSize];
            frame[0] = (byte)(header.Length >> 24); frame[1] = (byte)(header.Length >> 16); frame[2] = (byte)(header.Length >> 8); frame[3] = (byte)header.Length;
            Buffer.BlockCopy(header, 0, frame, 4, header.Length);
            Marshal.Copy(yp == IntPtr.Zero ? ybuf : yp, frame, 4 + header.Length, ySize);
            Marshal.Copy(cp == IntPtr.Zero ? cbuf : cp, frame, 4 + header.Length + ySize, cSize);
            await ws.SendAsync(new ArraySegment<byte>(frame), WebSocketMessageType.Binary, true, token);
        }

        // The TV's Bluetooth adapter and bonded devices (TV web apps have no Bluetooth API; .NET does).
        static string BluetoothJson(string id)
        {
            var sb = new StringBuilder("{\"t\":\"bluetooth\",\"id\":" + Quote(id ?? "") + ",");
            try
            {
                bool on = BluetoothAdapter.IsBluetoothEnabled;
                sb.Append("\"ok\":true,\"powered\":" + (on ? "true" : "false"));
                string name = null;
                try { name = BluetoothAdapter.Name; } catch (Exception) { }
                if (name != null) sb.Append(",\"name\":" + Quote(name));
                sb.Append(",\"devices\":[");
                if (on)
                {
                    int n = 0;
                    foreach (var d in BluetoothAdapter.GetBondedDevices())
                    {
                        if (n++ >= 20) break;
                        if (n > 1) sb.Append(',');
                        string kind = "";
                        try { kind = d.Class.MajorDeviceClassType.ToString(); } catch (Exception) { }
                        bool connected = false;
                        try { connected = d.IsConnected; } catch (Exception) { }
                        sb.Append("{\"name\":" + Quote(d.Name ?? "") + ",\"connected\":" + (connected ? "true" : "false") + ",\"bonded\":true,\"kind\":" + Quote(kind) + "}");
                    }
                }
                sb.Append("]}");
            }
            catch (Exception ex)
            {
                sb.Append("\"ok\":false,\"error\":" + Quote(ex.GetType().Name + ": " + ex.Message) + "}");
            }
            return sb.ToString();
        }

        // Memory: /proc/meminfo totals, running apps (app framework) with RSS/PSS, and every process whose
        // /proc entry this app may read, largest first. Read-only; nothing is stopped from here.
        static async Task<string> ProcsJson(string id)
        {
            var sb = new StringBuilder("{\"t\":\"procs\",\"id\":" + Quote(id ?? "") + ",\"ok\":true,\"meminfo\":{");
            try
            {
                int n = 0;
                foreach (var line in File.ReadAllLines("/proc/meminfo"))
                {
                    var m = Regex.Match(line, @"^(MemTotal|MemFree|MemAvailable|Buffers|Cached|SwapTotal|SwapFree|Shmem|SReclaimable|CmaTotal|CmaFree):\s+(\d+)");
                    if (!m.Success) continue;
                    if (n++ > 0) sb.Append(',');
                    sb.Append(Quote(m.Groups[1].Value) + ":" + m.Groups[2].Value);
                }
            }
            catch (Exception) { }
            sb.Append("},\"apps\":[");
            try
            {
                var apps = (await ApplicationManager.GetRunningApplicationsAsync()).ToList();
                var pids = apps.Select(a => a.ProcessId).ToList();
                Tizen.System.ProcessMemoryUsage usage = null;
                try { usage = new Tizen.System.ProcessMemoryUsage(pids); } catch (Exception) { }
                int n = 0;
                foreach (var a in apps)
                {
                    if (n++ > 0) sb.Append(',');
                    int rss = -1, pss = -1;
                    try { if (usage != null) { rss = usage.GetRss(a.ProcessId); pss = usage.GetPss(a.ProcessId); } } catch (Exception) { }
                    sb.Append("{\"id\":" + Quote(a.ApplicationId ?? "") + ",\"pid\":" + a.ProcessId + ",\"state\":" + Quote(a.State.ToString()) + ",\"rssKb\":" + rss + ",\"pssKb\":" + pss + "}");
                }
            }
            catch (Exception ex) { sb.Append("{\"error\":" + Quote(ex.GetType().Name + ": " + ex.Message) + "}"); }
            sb.Append("],\"procs\":[");
            try
            {
                var list = new List<Tuple<int, string, long, string>>();
                int unreadable = 0;
                foreach (var dir in Directory.GetDirectories("/proc"))
                {
                    var name = Path.GetFileName(dir);
                    if (!int.TryParse(name, out int pid)) continue;
                    try
                    {
                        string comm = null; long rss = 0;
                        foreach (var line in File.ReadAllLines(dir + "/status"))
                        {
                            if (line.StartsWith("Name:")) comm = line.Substring(5).Trim();
                            else if (line.StartsWith("VmRSS:")) long.TryParse(Regex.Match(line, @"\d+").Value, out rss);
                        }
                        string cmd = "";
                        try { cmd = File.ReadAllText(dir + "/cmdline").Replace('\0', ' ').Trim(); } catch (Exception) { }
                        list.Add(Tuple.Create(pid, comm ?? "", rss, cmd.Length > 160 ? cmd.Substring(0, 160) : cmd));
                    }
                    catch (Exception) { unreadable++; }
                }
                int k = 0;
                foreach (var p in list.OrderByDescending(p => p.Item3).Take(80))
                {
                    if (k++ > 0) sb.Append(',');
                    sb.Append("{\"pid\":" + p.Item1 + ",\"name\":" + Quote(p.Item2) + ",\"rssKb\":" + p.Item3 + ",\"cmd\":" + Quote(p.Item4) + "}");
                }
                sb.Append("],\"seen\":" + list.Count + ",\"unreadable\":" + unreadable + "}");
            }
            catch (Exception ex) { sb.Append("],\"procsError\":" + Quote(ex.GetType().Name + ": " + ex.Message) + "}"); }
            return sb.ToString();
        }

        static Task SendText(ClientWebSocket ws, string text, CancellationToken token) =>
            ws.SendAsync(new ArraySegment<byte>(Encoding.UTF8.GetBytes(text)), WebSocketMessageType.Text, true, token);

        // Lumen's requests are tiny flat JSON objects; a field reader avoids a JSON dependency.
        static string Field(string json, string name)
        {
            var m = Regex.Match(json, "\"" + name + "\"\\s*:\\s*(\"([^\"\\\\]*)\"|(-?\\d+))");
            if (!m.Success) return null;
            return m.Groups[2].Success ? m.Groups[2].Value : m.Groups[3].Value;
        }

        static int Number(string s, int fallback) => int.TryParse(s, out int n) ? n : fallback;

        static string Quote(string s)
        {
            var sb = new StringBuilder("\"");
            foreach (char ch in s)
            {
                if (ch == '"' || ch == '\\') sb.Append('\\').Append(ch);
                else if (ch < 0x20) sb.Append(' ');
                else sb.Append(ch);
            }
            return sb.Append('"').ToString();
        }

        protected override void OnTerminate()
        {
            current?.Cancel();
            base.OnTerminate();
        }

        static void Main(string[] args)
        {
            new App().Run(args);
        }
    }
}
