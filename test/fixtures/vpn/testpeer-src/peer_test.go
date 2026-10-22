package main

import (
	"context"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/netip"
	"strings"
	"testing"
	"time"

	"golang.zx2c4.com/wireguard/conn"
	"golang.zx2c4.com/wireguard/device"
	"golang.zx2c4.com/wireguard/tun/netstack"
)

// A second in-process netstack client plays the role of the TV-side tunnel.
func dialClient(t *testing.T, serverPort int, serverPublic, clientPrivate string) *netstack.Net {
	t.Helper()
	tun, tnet, err := netstack.CreateNetTUN([]netip.Addr{netip.MustParseAddr("10.66.0.2")}, []netip.Addr{netip.MustParseAddr("10.66.0.1")}, 1420)
	if err != nil {
		t.Fatal(err)
	}
	dev := device.NewDevice(tun, conn.NewDefaultBind(), device.NewLogger(device.LogLevelError, "client "))
	uapi := fmt.Sprintf("private_key=%s\npublic_key=%s\nendpoint=127.0.0.1:%d\nallowed_ip=0.0.0.0/0\npersistent_keepalive_interval=5\n",
		hexKey(t, clientPrivate), hexKey(t, serverPublic), serverPort)
	if err := dev.IpcSet(uapi); err != nil {
		t.Fatal(err)
	}
	if err := dev.Up(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(dev.Close)
	return tnet
}

func hexKey(t *testing.T, b64 string) string {
	t.Helper()
	h, err := base64ToHex(b64)
	if err != nil {
		t.Fatal(err)
	}
	return h
}

func TestPeerServesHTTPAndDNSInsideTheTunnel(t *testing.T) {
	serverKeys, err := GenerateKeys()
	if err != nil {
		t.Fatal(err)
	}
	clientKeys, err := GenerateKeys()
	if err != nil {
		t.Fatal(err)
	}
	peer, err := StartPeer(PeerConfig{Listen: "127.0.0.1:0", PrivateKey: serverKeys.Private, ClientPublicKey: clientKeys.Public,
		TunnelIP: "10.66.0.1", ClientIP: "10.66.0.2"})
	if err != nil {
		t.Fatal(err)
	}
	defer peer.Close()

	tnet := dialClient(t, peer.ListenPort(), serverKeys.Public, clientKeys.Private)
	client := &http.Client{Transport: &http.Transport{DialContext: func(ctx context.Context, network, addr string) (net.Conn, error) { return tnet.DialContext(ctx, network, addr) }}, Timeout: 10 * time.Second}

	resp, err := client.Get("http://10.66.0.1/hello")
	if err != nil {
		t.Fatal(err)
	}
	body, _ := io.ReadAll(resp.Body)
	resp.Body.Close()
	if string(body) != "hello from wg peer\n" {
		t.Fatalf("unexpected body %q", body)
	}

	resp, err = client.Get("http://10.66.0.1/blob?bytes=100000")
	if err != nil {
		t.Fatal(err)
	}
	blob, _ := io.ReadAll(resp.Body)
	resp.Body.Close()
	if len(blob) != 100000 || blob[0] != 0x5a || blob[len(blob)-1] != 0x5a {
		t.Fatalf("blob wrong: len=%d", len(blob))
	}

	resolver := &net.Resolver{PreferGo: true, Dial: func(ctx context.Context, network, address string) (net.Conn, error) { return tnet.DialContext(ctx, "udp", "10.66.0.1:53") }}
	addrs, err := resolver.LookupHost(context.Background(), "anything.test")
	if err != nil {
		t.Fatal(err)
	}
	if len(addrs) != 1 || addrs[0] != "10.66.0.1" {
		t.Fatalf("dns answer %v", addrs)
	}
	if !strings.Contains(peer.Log(), "handshake ok") {
		t.Fatalf("expected handshake log, got %q", peer.Log())
	}
}
