package main

// Client mode: a userspace WireGuard client (wireguard-go + gvisor netstack) that
// downloads one URL through a wg-quick .conf. It measures what the WireGuard path
// itself can carry from this machine, independent of the WASM core, so the TV's
// numbers can be compared against a native-speed baseline.

import (
	"bufio"
	"context"
	"flag"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/netip"
	"os"
	"strings"
	"time"

	"golang.zx2c4.com/wireguard/conn"
	"golang.zx2c4.com/wireguard/device"
	"golang.zx2c4.com/wireguard/tun/netstack"
)

func runClient(args []string) {
	fs := flag.NewFlagSet("client", flag.ExitOnError)
	confPath := fs.String("conf", "", "wg-quick .conf (keys are read from the file only)")
	url := fs.String("url", "http://speed.cloudflare.com/__down?bytes=50000000", "URL to download through the tunnel")
	urls := fs.String("urls", "", "file of URLs to GET through one tunnel session (one per line; optional \" | Header: value\" suffixes)")
	proxy := fs.String("proxy", "", "serve a local HTTP proxy (CONNECT and plain HTTP) whose connections go through the tunnel, e.g. 127.0.0.1:18990")
	fs.Parse(args)
	if *confPath == "" {
		usage()
	}
	f, err := os.Open(*confPath)
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	defer f.Close()
	var priv, pub, endpoint, addr, dns string
	keepalive := 25
	sc := bufio.NewScanner(f)
	for sc.Scan() {
		line := strings.TrimSpace(sc.Text())
		if line == "" || line[0] == '#' || line[0] == '[' {
			continue
		}
		kv := strings.SplitN(line, "=", 2)
		if len(kv) != 2 {
			continue
		}
		k, v := strings.TrimSpace(kv[0]), strings.TrimSpace(kv[1])
		switch k {
		case "PrivateKey":
			priv = v
		case "PublicKey":
			pub = v
		case "Endpoint":
			endpoint = v
		case "Address":
			addr = strings.Split(strings.Split(v, ",")[0], "/")[0]
		case "DNS":
			dns = strings.TrimSpace(strings.Split(v, ",")[0])
		case "PersistentKeepalive":
			fmt.Sscan(v, &keepalive)
		}
	}
	privHex, err := base64ToHex(priv)
	if err != nil {
		fmt.Fprintln(os.Stderr, "private key:", err)
		os.Exit(1)
	}
	pubHex, err := base64ToHex(pub)
	if err != nil {
		fmt.Fprintln(os.Stderr, "peer key:", err)
		os.Exit(1)
	}
	host, port, err := net.SplitHostPort(endpoint)
	if err != nil {
		fmt.Fprintln(os.Stderr, "endpoint:", err)
		os.Exit(1)
	}
	ips, err := net.LookupIP(host)
	if err != nil || len(ips) == 0 {
		fmt.Fprintln(os.Stderr, "endpoint lookup failed:", err)
		os.Exit(1)
	}
	var endpointIP string
	for _, ip := range ips {
		if ip4 := ip.To4(); ip4 != nil {
			endpointIP = ip4.String()
			break
		}
	}
	tunDev, tnet, err := netstack.CreateNetTUN([]netip.Addr{netip.MustParseAddr(addr)}, []netip.Addr{netip.MustParseAddr(dns)}, 1420)
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	dev := device.NewDevice(tunDev, conn.NewDefaultBind(), device.NewLogger(device.LogLevelError, "wg "))
	uapi := fmt.Sprintf("private_key=%s\npublic_key=%s\nendpoint=%s\nallowed_ip=0.0.0.0/0\npersistent_keepalive_interval=%d\n", privHex, pubHex, net.JoinHostPort(endpointIP, port), keepalive)
	if err := dev.IpcSet(uapi); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	if err := dev.Up(); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	client := &http.Client{Timeout: 120 * time.Second, Transport: &http.Transport{DialContext: func(ctx context.Context, network, address string) (net.Conn, error) {
		return tnet.DialContext(ctx, network, address)
	}}}
	if *urls != "" {
		probeList(client, *urls, endpoint)
		dev.Close()
		return
	}
	if *proxy != "" {
		serveProxy(tnet, *proxy, endpoint)
		dev.Close()
		return
	}
	t0 := time.Now()
	resp, err := client.Get(*url)
	if err != nil {
		fmt.Fprintln(os.Stderr, "GET failed:", err)
		dev.Close()
		os.Exit(1)
	}
	n, _ := io.Copy(io.Discard, resp.Body)
	resp.Body.Close()
	el := time.Since(t0)
	fmt.Printf("native wireguard-go client: %d bytes in %.2fs = %.1f Mbit/s (HTTP %d) via %s\n", n, el.Seconds(), float64(n)*8/el.Seconds()/1e6, resp.StatusCode, endpoint)
	dev.Close()
}

// probeList GETs each listed URL through the same tunnel session and prints status, size, time and a page title.
func probeList(client *http.Client, path, endpoint string) {
	data, err := os.ReadFile(path)
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	client.Timeout = 20 * time.Second
	for _, line := range strings.Split(string(data), "\n") {
		parts := strings.Split(strings.TrimSpace(line), " | ")
		if parts[0] == "" || strings.HasPrefix(parts[0], "#") {
			continue
		}
		req, err := http.NewRequest("GET", parts[0], nil)
		if err != nil {
			fmt.Printf("BAD %s %v\n", parts[0], err)
			continue
		}
		req.Header.Set("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36")
		for _, h := range parts[1:] {
			if kv := strings.SplitN(h, ":", 2); len(kv) == 2 {
				req.Header.Set(strings.TrimSpace(kv[0]), strings.TrimSpace(kv[1]))
			}
		}
		t0 := time.Now()
		resp, err := client.Do(req)
		if err != nil {
			fmt.Printf("ERR  %-6dms %s %v\n", time.Since(t0).Milliseconds(), parts[0], err)
			continue
		}
		body, _ := io.ReadAll(io.LimitReader(resp.Body, 4<<20))
		resp.Body.Close()
		title := ""
		if i := strings.Index(strings.ToLower(string(body)), "<title>"); i >= 0 {
			rest := string(body[i+7:])
			if j := strings.Index(strings.ToLower(rest), "</title>"); j >= 0 && j < 120 {
				title = strings.TrimSpace(rest[:j])
			}
		}
		fmt.Printf("%d %-6dms %8dB %s %q\n", resp.StatusCode, time.Since(t0).Milliseconds(), len(body), parts[0], title)
	}
	fmt.Printf("via %s\n", endpoint)
}

// serveProxy serves a local forward proxy whose upstream connections (and DNS) go through the tunnel, so ordinary
// tools (curl -x, Python requests) can reach hosts that answer only through it. Loopback listeners only.
func serveProxy(tnet *netstack.Net, listen, endpoint string) {
	if host, _, err := net.SplitHostPort(listen); err != nil || !net.ParseIP(host).IsLoopback() {
		fmt.Fprintln(os.Stderr, "proxy: listen on a loopback address only")
		os.Exit(1)
	}
	dial := func(ctx context.Context, network, address string) (net.Conn, error) { return tnet.DialContext(ctx, network, address) }
	upstream := &http.Transport{DialContext: dial, ResponseHeaderTimeout: 60 * time.Second}
	handler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodConnect {
			ctx, cancel := context.WithTimeout(r.Context(), 20*time.Second)
			up, err := dial(ctx, "tcp", r.Host)
			cancel()
			if err != nil {
				http.Error(w, err.Error(), http.StatusBadGateway)
				return
			}
			hj, ok := w.(http.Hijacker)
			if !ok {
				up.Close()
				http.Error(w, "no hijack", http.StatusInternalServerError)
				return
			}
			down, buf, err := hj.Hijack()
			if err != nil {
				up.Close()
				return
			}
			down.Write([]byte("HTTP/1.1 200 Connection established\r\n\r\n"))
			if n := buf.Reader.Buffered(); n > 0 {
				pending, _ := buf.Reader.Peek(n)
				up.Write(pending)
			}
			go func() { io.Copy(up, down); up.Close() }()
			io.Copy(down, up)
			down.Close()
			return
		}
		if !r.URL.IsAbs() {
			http.Error(w, "proxy requests only", http.StatusBadRequest)
			return
		}
		out := r.Clone(r.Context())
		out.RequestURI = ""
		out.Header.Del("Proxy-Connection")
		resp, err := upstream.RoundTrip(out)
		if err != nil {
			http.Error(w, err.Error(), http.StatusBadGateway)
			return
		}
		defer resp.Body.Close()
		for k, vs := range resp.Header {
			for _, v := range vs {
				w.Header().Add(k, v)
			}
		}
		w.WriteHeader(resp.StatusCode)
		io.Copy(w, resp.Body)
	})
	fmt.Printf("proxy on http://%s via %s (Ctrl+C to stop)\n", listen, endpoint)
	if err := http.ListenAndServe(listen, handler); err != nil {
		fmt.Fprintln(os.Stderr, "proxy:", err)
	}
}
