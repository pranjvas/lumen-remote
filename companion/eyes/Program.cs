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
// Also: {t:'bluetooth', id} → adapter + bonded devices; {t:'procs', id, detail?: 1} → memory totals and
// running apps; with detail 1 also per-app RSS/PSS and the largest processes {pid, name, rssKb}.
// Bluetooth actions (0.4.0, public privilege http://tizen.org/privilege/bluetooth only):
// {t:'bt-scan', id, secs} → {t:'bt-found', id, device} per device seen, then {t:'bt-scan', id, ok, devices};
// {t:'bt-scan-stop'} ends a running scan early; {t:'bt-pair'|'bt-connect'|'bt-disconnect', id, address}
// → {t:<same>, id, ok, paired?, connected, profile?, connectError?, device?} or {ok:false, error}.
// A device is {address, name, kind, minor, rssi, paired, connected}.
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
        const string Version = "0.4.0";
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
        // ClientWebSocket allows one send at a time; memory answers are sent from a background task
        // while the receive loop keeps serving captures, so every send takes this lock.
        static readonly SemaphoreSlim sendLock = new SemaphoreSlim(1, 1);
        // One memory reading at a time (it walks /proc); later requests wait their turn off the loop.
        static readonly SemaphoreSlim procsGate = new SemaphoreSlim(1, 1);

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
                            if (type == "procs") AnswerProcs(ws, Field(msg, "id"), Number(Field(msg, "detail"), 0) == 1, token);
                            if (type == "bt-scan") BtScan(ws, Field(msg, "id"), Number(Field(msg, "secs"), 15), token);
                            if (type == "bt-scan-stop") StopScan();
                            if (type == "bt-pair" || type == "bt-connect" || type == "bt-disconnect") BtAction(ws, type, Field(msg, "id"), Field(msg, "address"), token);
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
            await Send(ws, frame, WebSocketMessageType.Binary, token);
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
                        string kind = "", minor = "", address = "";
                        try { kind = d.Class.MajorDeviceClassType.ToString(); } catch (Exception) { }
                        try { minor = d.Class.MinorDeviceClassType.ToString(); } catch (Exception) { }
                        try { address = d.Address ?? ""; } catch (Exception) { }
                        bool connected = false;
                        try { connected = d.IsConnected; } catch (Exception) { }
                        sb.Append("{\"name\":" + Quote(d.Name ?? "") + ",\"connected\":" + (connected ? "true" : "false") + ",\"bonded\":true,\"kind\":" + Quote(kind)
                            + ",\"minor\":" + Quote(minor) + ",\"address\":" + Quote(address) + "}");
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

        // ---- Bluetooth actions: scan, pair, connect, disconnect (Tizen.Network.Bluetooth, public privilege) ----
        // One action at a time (btGate); a pair, connect or disconnect stops a running scan first, because
        // bonding during an inquiry is slow and unreliable. Each runs off the receive loop like procs, so
        // captures keep flowing while a device pairs. Devices seen by a scan are kept by address: CreateBond
        // needs a BluetoothDevice, and the platform only hands those out from discovery or the bonded list.

        static readonly SemaphoreSlim btGate = new SemaphoreSlim(1, 1);
        static readonly object btLock = new object();
        static readonly Dictionary<string, BluetoothDevice> seenDevices = new Dictionary<string, BluetoothDevice>(StringComparer.OrdinalIgnoreCase);
        static readonly Regex MacAddress = new Regex("^([0-9A-Fa-f]{2}:){5}[0-9A-Fa-f]{2}$");
        static CancellationTokenSource scanCts;
        const int PairTimeoutMs = 60000;   // the TV may ask the owner to confirm a code on screen
        const int ConnectTimeoutMs = 20000;
        const int DisconnectTimeoutMs = 10000;

        static void BtScan(ClientWebSocket ws, string id, int secs, CancellationToken token)
        {
            if (id == null || id.Length > 64) return;
            secs = Math.Max(4, Math.Min(secs, 30));
            Task.Run(async () =>
            {
                string json;
                try
                {
                    await btGate.WaitAsync(token);
                    try { json = await ScanJson(ws, id, secs, token); }
                    finally { btGate.Release(); }
                }
                catch (Exception ex) { json = BtFailure("bt-scan", id, ex); }
                await SendQuietly(ws, json, token);
            });
        }

        static void StopScan()
        {
            lock (btLock) { try { scanCts?.Cancel(); } catch (Exception) { } }
        }

        static async Task<string> ScanJson(ClientWebSocket ws, string id, int secs, CancellationToken token)
        {
            if (!BluetoothAdapter.IsBluetoothEnabled) return BtFailure("bt-scan", id, "NotEnabled: Bluetooth is off on the TV");
            var found = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase); // address → device JSON
            var cts = CancellationTokenSource.CreateLinkedTokenSource(token);
            lock (btLock) { scanCts = cts; }
            TaskCompletionSource<bool> finished = null;
            EventHandler<DiscoveryStateChangedEventArgs> onState = (s, e) =>
            {
                try
                {
                    if (e.DiscoveryState == BluetoothDeviceDiscoveryState.Found && e.DeviceFound != null)
                    {
                        var d = e.DeviceFound;
                        string address = d.Address;
                        if (string.IsNullOrEmpty(address)) return;
                        string json = DeviceJson(d);
                        lock (btLock)
                        {
                            seenDevices[address] = d;
                            if (found.TryGetValue(address, out var prev) && prev == json) return;
                            found[address] = json;
                        }
                        Fire(ws, "{\"t\":\"bt-found\",\"id\":" + Quote(id) + ",\"device\":" + json + "}", token);
                    }
                    else if (e.DiscoveryState == BluetoothDeviceDiscoveryState.Finished) finished?.TrySetResult(true);
                }
                catch (Exception) { }
            };
            BluetoothAdapter.DiscoveryStateChanged += onState;
            try
            {
                var until = DateTime.UtcNow.AddSeconds(secs);
                // One platform inquiry lasts about 10-12 s; a longer scan starts the next one when it ends.
                while (!cts.IsCancellationRequested && (until - DateTime.UtcNow).TotalMilliseconds > 1500)
                {
                    var started = DateTime.UtcNow;
                    finished = new TaskCompletionSource<bool>(TaskCreationOptions.RunContinuationsAsynchronously);
                    try { BluetoothAdapter.StartDiscovery(); }
                    catch (InvalidOperationException) when (Discovering()) { } // already running (the TV's own scan): use its results
                    var left = until - DateTime.UtcNow;
                    if (left < TimeSpan.Zero) left = TimeSpan.Zero;
                    await Task.WhenAny(finished.Task, Task.Delay(left, cts.Token));
                    // An inquiry that ends at once is not restarted in a tight loop.
                    if (finished.Task.IsCompleted && (DateTime.UtcNow - started).TotalMilliseconds < 2000) await Task.WhenAny(Task.Delay(1000, cts.Token));
                }
            }
            finally
            {
                if (Discovering()) { try { BluetoothAdapter.StopDiscovery(); } catch (Exception) { } }
                BluetoothAdapter.DiscoveryStateChanged -= onState;
                lock (btLock) { if (scanCts == cts) scanCts = null; }
                cts.Dispose();
            }
            var sb = new StringBuilder("{\"t\":\"bt-scan\",\"id\":" + Quote(id) + ",\"ok\":true,\"devices\":[");
            lock (btLock) { sb.Append(string.Join(",", found.Values.Take(40))); }
            return sb.Append("]}").ToString();
        }

        static void BtAction(ClientWebSocket ws, string type, string id, string address, CancellationToken token)
        {
            if (id == null || id.Length > 64) return;
            if (address == null || !MacAddress.IsMatch(address))
            {
                Fire(ws, BtFailure(type, id, "InvalidParameter: bad device address"), token);
                return;
            }
            StopScan();
            Task.Run(async () =>
            {
                string json;
                try
                {
                    await btGate.WaitAsync(token);
                    try
                    {
                        if (!BluetoothAdapter.IsBluetoothEnabled) json = BtFailure(type, id, "NotEnabled: Bluetooth is off on the TV");
                        else if (type == "bt-pair") json = await PairJson(id, address, token);
                        else if (type == "bt-connect") json = await ConnectJson(id, address, token);
                        else json = await DisconnectJson(id, address, token);
                    }
                    finally { btGate.Release(); }
                }
                catch (Exception ex) { json = BtFailure(type, id, ex); }
                await SendQuietly(ws, json, token);
            });
        }

        static async Task<string> PairJson(string id, string address, CancellationToken token)
        {
            string head = "{\"t\":\"bt-pair\",\"id\":" + Quote(id) + ",";
            var device = BondedDevice(address);
            if (device == null)
            {
                lock (btLock) { seenDevices.TryGetValue(address, out device); }
                if (device == null) device = await FindDevice(address, 12, token);
                if (device == null) return BtFailure("bt-pair", id, "RemoteDeviceNotFound: the device is not in pairing mode or is out of range");
                // The bond result as a BluetoothError code: 0 (None) or AlreadyDone mean bonded.
                var bonded = new TaskCompletionSource<int>(TaskCreationOptions.RunContinuationsAsynchronously);
                EventHandler<BondCreatedEventArgs> onBond = (s, e) =>
                {
                    try
                    {
                        string at = null;
                        try { at = e.Device?.Address; } catch (Exception) { }
                        if (at == null || Same(at, address)) bonded.TrySetResult(Convert.ToInt32(e.Result));
                    }
                    catch (Exception) { }
                };
                device.BondCreated += onBond;
                try
                {
                    device.CreateBond();
                    // The bond event decides; the bonded list is also polled in case the event is lost.
                    var deadline = DateTime.UtcNow.AddMilliseconds(PairTimeoutMs);
                    while (!bonded.Task.IsCompleted && DateTime.UtcNow < deadline)
                    {
                        token.ThrowIfCancellationRequested();
                        await Task.WhenAny(bonded.Task, Task.Delay(1000, token));
                        if (!bonded.Task.IsCompleted && BondedDevice(address) != null) bonded.TrySetResult(0);
                    }
                    if (!bonded.Task.IsCompleted)
                    {
                        try { device.CancelBonding(); } catch (Exception) { }
                        return BtFailure("bt-pair", id, "TimedOut: pairing did not finish in " + (PairTimeoutMs / 1000) + " s");
                    }
                    int code = bonded.Task.Result;
                    if (code != 0 && code != (int)BluetoothError.AlreadyDone)
                    {
                        string name = Enum.GetName(typeof(BluetoothError), code) ?? ("Error" + code);
                        return BtFailure("bt-pair", id, name + ": pairing failed");
                    }
                }
                finally { device.BondCreated -= onBond; }
            }
            // Audio and input devices are connected straight away, as the TV menu does after pairing.
            var paired = BondedDevice(address) ?? device;
            bool connected = LinkUp(address);
            string profile = null, connectError = null;
            if (!connected)
            {
                var c = await Connect(paired, address, token);
                connected = c.Item1; profile = c.Item2; connectError = c.Item3;
            }
            return head + "\"ok\":true,\"paired\":true,\"connected\":" + (connected ? "true" : "false")
                + (profile != null ? ",\"profile\":" + Quote(profile) : "")
                + (connectError != null ? ",\"connectError\":" + Quote(connectError) : "")
                + ",\"device\":" + DeviceJson(paired, connected) + "}";
        }

        static async Task<string> ConnectJson(string id, string address, CancellationToken token)
        {
            var device = BondedDevice(address);
            if (device == null) return BtFailure("bt-connect", id, "RemoteDeviceNotBonded: pair the device first");
            if (LinkUp(address)) return "{\"t\":\"bt-connect\",\"id\":" + Quote(id) + ",\"ok\":true,\"connected\":true,\"device\":" + DeviceJson(device, true) + "}";
            var c = await Connect(device, address, token);
            if (!c.Item1) return BtFailure("bt-connect", id, c.Item3 ?? "OperationFailed: the device did not connect");
            return "{\"t\":\"bt-connect\",\"id\":" + Quote(id) + ",\"ok\":true,\"connected\":true,\"profile\":" + Quote(c.Item2 ?? "") + ",\"device\":" + DeviceJson(device, true) + "}";
        }

        static async Task<string> DisconnectJson(string id, string address, CancellationToken token)
        {
            var device = BondedDevice(address);
            if (device == null) return BtFailure("bt-disconnect", id, "RemoteDeviceNotBonded: the device is not paired");
            string error = null;
            if (LinkUp(address))
            {
                bool audio = IsAudio(device), hid = IsInput(device);
                try
                {
                    if (audio)
                    {
                        var a = device.GetProfile<BluetoothAudio>();
                        try { a.Disconnect(BluetoothAudioProfileType.AdvancedAudioDistribution); }
                        catch (Exception) { a.Disconnect(BluetoothAudioProfileType.All); }
                    }
                    else if (hid) device.GetProfile<BluetoothHid>().Disconnect();
                    else error = "NotSupported: Lumen disconnects audio and input devices only";
                }
                catch (Exception ex) { error = Describe(ex); }
                if (error == null)
                {
                    var deadline = DateTime.UtcNow.AddMilliseconds(DisconnectTimeoutMs);
                    while (LinkUp(address) && DateTime.UtcNow < deadline) await Task.Delay(500, token);
                    if (LinkUp(address)) error = "TimedOut: the device is still connected";
                }
            }
            if (error != null) return BtFailure("bt-disconnect", id, error);
            return "{\"t\":\"bt-disconnect\",\"id\":" + Quote(id) + ",\"ok\":true,\"connected\":false,\"device\":" + DeviceJson(device, false) + "}";
        }

        // Connects a bonded device with the profile its class calls for: A2DP (the TV as the audio source)
        // for headphones and speakers, HID for keyboards, mice and game pads. → (connected, profile, error).
        static async Task<Tuple<bool, string, string>> Connect(BluetoothDevice device, string address, CancellationToken token)
        {
            bool audio = IsAudio(device), hid = !audio && IsInput(device);
            if (!audio && !hid) return Tuple.Create(false, (string)null, "NotSupported: Lumen connects audio and input devices; connect this one from the device itself");
            string profile = audio ? "a2dp" : "hid";
            // A connected event settles it at once; a "not connected" event only counts once the link is
            // still down a few seconds later (with All, the headset profile can fail while A2DP connects).
            var changed = new TaskCompletionSource<bool>(TaskCreationOptions.RunContinuationsAsynchronously);
            int refusals = 0;
            EventHandler<AudioConnectionStateChangedEventArgs> onAudio = (s, e) =>
            {
                try { if (Same(e.Address, address)) { if (e.IsConnected) changed.TrySetResult(true); else Interlocked.Increment(ref refusals); } } catch (Exception) { }
            };
            EventHandler<HidConnectionStateChangedEventArgs> onHid = (s, e) =>
            {
                try { if (Same(e.Address, address)) { if (e.IsConnected) changed.TrySetResult(true); else Interlocked.Increment(ref refusals); } } catch (Exception) { }
            };
            BluetoothAudio a = null;
            BluetoothHid h = null;
            try
            {
                if (audio)
                {
                    a = device.GetProfile<BluetoothAudio>();
                    a.AudioConnectionStateChanged += onAudio;
                    try { a.Connect(BluetoothAudioProfileType.AdvancedAudioDistribution); }
                    catch (Exception) { a.Connect(BluetoothAudioProfileType.All); profile = "audio"; }
                }
                else
                {
                    h = device.GetProfile<BluetoothHid>();
                    h.HidConnectionStateChanged += onHid;
                    h.Connect();
                }
                var deadline = DateTime.UtcNow.AddMilliseconds(ConnectTimeoutMs);
                int downAfterRefusal = 0;
                while (!changed.Task.IsCompleted && DateTime.UtcNow < deadline)
                {
                    token.ThrowIfCancellationRequested();
                    await Task.WhenAny(changed.Task, Task.Delay(1000, token));
                    if (changed.Task.IsCompleted) break;
                    if (LinkUp(address)) { changed.TrySetResult(true); break; }
                    if (Volatile.Read(ref refusals) > 0 && ++downAfterRefusal >= 3) changed.TrySetResult(false);
                }
                if (!changed.Task.IsCompleted) return Tuple.Create(false, profile, "TimedOut: the device did not connect in " + (ConnectTimeoutMs / 1000) + " s");
                if (!changed.Task.Result) return Tuple.Create(false, profile, "OperationFailed: the device refused the connection");
                return Tuple.Create(true, profile, (string)null);
            }
            catch (Exception ex) { return Tuple.Create(false, profile, Describe(ex)); }
            finally
            {
                if (a != null) a.AudioConnectionStateChanged -= onAudio;
                if (h != null) h.HidConnectionStateChanged -= onHid;
            }
        }

        // A short discovery that stops as soon as `address` shows up (pairing a device Lumen has not seen).
        static async Task<BluetoothDevice> FindDevice(string address, int secs, CancellationToken token)
        {
            var hit = new TaskCompletionSource<BluetoothDevice>(TaskCreationOptions.RunContinuationsAsynchronously);
            EventHandler<DiscoveryStateChangedEventArgs> onState = (s, e) =>
            {
                try
                {
                    if (e.DiscoveryState == BluetoothDeviceDiscoveryState.Found && e.DeviceFound != null && Same(e.DeviceFound.Address, address))
                    {
                        lock (btLock) { seenDevices[address] = e.DeviceFound; }
                        hit.TrySetResult(e.DeviceFound);
                    }
                    else if (e.DiscoveryState == BluetoothDeviceDiscoveryState.Finished) hit.TrySetResult(null);
                }
                catch (Exception) { }
            };
            BluetoothAdapter.DiscoveryStateChanged += onState;
            try
            {
                try { BluetoothAdapter.StartDiscovery(); } catch (InvalidOperationException) when (Discovering()) { }
                await Task.WhenAny(hit.Task, Task.Delay(secs * 1000, token));
                return hit.Task.IsCompleted ? hit.Task.Result : null;
            }
            finally
            {
                if (Discovering()) { try { BluetoothAdapter.StopDiscovery(); } catch (Exception) { } }
                BluetoothAdapter.DiscoveryStateChanged -= onState;
            }
        }

        static BluetoothDevice BondedDevice(string address)
        {
            try { return BluetoothAdapter.GetBondedDevice(address); } catch (Exception) { return null; }
        }

        // A device object is a snapshot; the live link state is asked by address each time.
        static bool LinkUp(string address)
        {
            var d = BondedDevice(address);
            if (d == null) return false;
            try { if (d.IsConnected) return true; } catch (Exception) { }
            foreach (var p in new[] { BluetoothProfileType.AdvancedAudioDistribution, BluetoothProfileType.HumanInterfaceDevice })
            {
                try { if (d.IsProfileConnected(p)) return true; } catch (Exception) { }
            }
            return false;
        }

        static bool IsAudio(BluetoothDevice d)
        {
            try { if (d.Class.MajorDeviceClassType == BluetoothMajorDeviceClassType.AudioVideo) return true; } catch (Exception) { }
            return HasService(d, "0000110B") || HasService(d, "0000110D"); // A2DP sink, advanced audio
        }

        static bool IsInput(BluetoothDevice d)
        {
            try { if (d.Class.MajorDeviceClassType == BluetoothMajorDeviceClassType.Peripheral) return true; } catch (Exception) { }
            return HasService(d, "00001124"); // HID
        }

        static bool HasService(BluetoothDevice d, string prefix)
        {
            try { return d.ServiceUuidList != null && d.ServiceUuidList.Any(u => u != null && u.StartsWith(prefix, StringComparison.OrdinalIgnoreCase)); }
            catch (Exception) { return false; }
        }

        static bool Discovering()
        {
            try { return BluetoothAdapter.IsDiscoveryInProgress; } catch (Exception) { return false; }
        }

        static bool Same(string a, string b) => a != null && b != null && string.Equals(a, b, StringComparison.OrdinalIgnoreCase);

        static string DeviceJson(BluetoothDevice d, bool? connected = null)
        {
            string address = "", name = "", kind = "", minor = "";
            int rssi = 0;
            bool paired = false, linked = false;
            try { address = d.Address ?? ""; } catch (Exception) { }
            try { name = d.Name ?? ""; } catch (Exception) { }
            try { kind = d.Class.MajorDeviceClassType.ToString(); } catch (Exception) { }
            try { minor = d.Class.MinorDeviceClassType.ToString(); } catch (Exception) { }
            try { rssi = d.Rssi; } catch (Exception) { }
            try { paired = d.IsPaired; } catch (Exception) { }
            try { linked = d.IsConnected; } catch (Exception) { }
            if (connected.HasValue) { linked = connected.Value; paired = true; }
            return "{\"address\":" + Quote(address) + ",\"name\":" + Quote(name) + ",\"kind\":" + Quote(kind) + ",\"minor\":" + Quote(minor)
                + ",\"rssi\":" + rssi + ",\"paired\":" + (paired ? "true" : "false") + ",\"connected\":" + (linked ? "true" : "false") + "}";
        }

        // Exception → "Type: message", so Lumen can tell a refusal (NotSupported, permission) from a failure.
        static string Describe(Exception ex) => ex.GetType().Name + ": " + ex.Message;

        static string BtFailure(string type, string id, Exception ex) => BtFailure(type, id, Describe(ex));

        static string BtFailure(string type, string id, string error) =>
            "{\"t\":" + Quote(type) + ",\"id\":" + Quote(id ?? "") + ",\"ok\":false,\"error\":" + Quote(error) + "}";

        static void Fire(ClientWebSocket ws, string text, CancellationToken token)
        {
            Task.Run(() => SendQuietly(ws, text, token));
        }

        static async Task SendQuietly(ClientWebSocket ws, string text, CancellationToken token)
        {
            try { if (ws.State == WebSocketState.Open) await SendText(ws, text, token); } catch (Exception) { }
        }

        // Answers {t:'procs'} from a background task so captures and Bluetooth requests keep flowing
        // while /proc is read; the answer is sent under sendLock like every other message.
        static void AnswerProcs(ClientWebSocket ws, string id, bool detail, CancellationToken token)
        {
            Task.Run(async () =>
            {
                try
                {
                    await procsGate.WaitAsync(token);
                    string json;
                    try { json = await ProcsJson(id, detail); }
                    finally { procsGate.Release(); }
                    if (ws.State == WebSocketState.Open) await SendText(ws, json, token);
                }
                catch (Exception) { }
            });
        }

        // Memory: /proc/meminfo totals and the running apps (app framework). With detail, also each app's
        // RSS/PSS (smaps parsing, slow for big web apps) and every process whose /proc status this app may
        // read, largest first: pid, name and RSS only. Command lines are never read or sent: on Tizen they
        // carry launch bundles and URLs with keys (Eyes' own is ws://<pc>/eyes?key=...). Read-only; nothing
        // is stopped from here.
        static async Task<string> ProcsJson(string id, bool detail)
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
                Tizen.System.ProcessMemoryUsage usage = null;
                if (detail)
                {
                    try { usage = new Tizen.System.ProcessMemoryUsage(apps.Select(a => a.ProcessId).ToList()); } catch (Exception) { }
                }
                int n = 0;
                foreach (var a in apps)
                {
                    if (n++ > 0) sb.Append(',');
                    sb.Append("{\"id\":" + Quote(a.ApplicationId ?? "") + ",\"pid\":" + a.ProcessId + ",\"state\":" + Quote(a.State.ToString()));
                    if (detail)
                    {
                        int rss = -1, pss = -1;
                        try { if (usage != null) { rss = usage.GetRss(a.ProcessId); pss = usage.GetPss(a.ProcessId); } } catch (Exception) { }
                        sb.Append(",\"rssKb\":" + rss + ",\"pssKb\":" + pss);
                    }
                    sb.Append('}');
                }
            }
            catch (Exception ex) { sb.Append("{\"error\":" + Quote(ex.GetType().Name + ": " + ex.Message) + "}"); }
            if (!detail) return sb.Append("]}").ToString();
            sb.Append("],\"procs\":[");
            try
            {
                var list = new List<Tuple<int, string, long>>();
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
                        list.Add(Tuple.Create(pid, comm ?? "", rss));
                    }
                    catch (Exception) { unreadable++; }
                }
                int k = 0;
                foreach (var p in list.OrderByDescending(p => p.Item3).Take(80))
                {
                    if (k++ > 0) sb.Append(',');
                    sb.Append("{\"pid\":" + p.Item1 + ",\"name\":" + Quote(p.Item2) + ",\"rssKb\":" + p.Item3 + "}");
                }
                sb.Append("],\"seen\":" + list.Count + ",\"unreadable\":" + unreadable + "}");
            }
            catch (Exception ex) { sb.Append("],\"procsError\":" + Quote(ex.GetType().Name + ": " + ex.Message) + "}"); }
            return sb.ToString();
        }

        static Task SendText(ClientWebSocket ws, string text, CancellationToken token) =>
            Send(ws, Encoding.UTF8.GetBytes(text), WebSocketMessageType.Text, token);

        static async Task Send(ClientWebSocket ws, byte[] bytes, WebSocketMessageType type, CancellationToken token)
        {
            await sendLock.WaitAsync(token);
            try { await ws.SendAsync(new ArraySegment<byte>(bytes), type, true, token); }
            finally { sendLock.Release(); }
        }

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
