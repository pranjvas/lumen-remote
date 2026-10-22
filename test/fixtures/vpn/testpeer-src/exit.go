package main

// Exit mode: a userspace WireGuard peer that FORWARDS the client's tunnel traffic
// to the real internet from this machine (TCP via a gvisor forwarder and host
// dials, UDP relayed, DNS to 10.66.0.1:53 answered by a public resolver). It
// stands in for a Proton endpoint so playback through the tunnel can be tested
// end to end before a real Proton config is available. The packet plumbing
// mirrors golang.zx2c4.com/wireguard/tun/netstack (MIT).

import (
	"fmt"
	"io"
	"net"
	"net/http"
	"net/netip"
	"os"
	"strconv"
	"strings"
	"sync"
	"time"

	"golang.zx2c4.com/wireguard/conn"
	"golang.zx2c4.com/wireguard/device"
	"golang.zx2c4.com/wireguard/tun"
	"gvisor.dev/gvisor/pkg/buffer"
	"gvisor.dev/gvisor/pkg/tcpip"
	"gvisor.dev/gvisor/pkg/tcpip/adapters/gonet"
	"gvisor.dev/gvisor/pkg/tcpip/header"
	"gvisor.dev/gvisor/pkg/tcpip/link/channel"
	"gvisor.dev/gvisor/pkg/tcpip/network/ipv4"
	"gvisor.dev/gvisor/pkg/tcpip/stack"
	"gvisor.dev/gvisor/pkg/tcpip/transport/icmp"
	"gvisor.dev/gvisor/pkg/tcpip/transport/tcp"
	"gvisor.dev/gvisor/pkg/tcpip/transport/udp"
	"gvisor.dev/gvisor/pkg/waiter"
)

type exitTun struct {
	ep       *channel.Endpoint
	stack    *stack.Stack
	events   chan tun.Event
	notify   *channel.NotificationHandle
	incoming chan *buffer.View
	mtu      int
}

func (t *exitTun) Name() (string, error) { return "exit", nil }
func (t *exitTun) File() *os.File         { return nil }
func (t *exitTun) Events() <-chan tun.Event { return t.events }
func (t *exitTun) MTU() (int, error)      { return t.mtu, nil }
func (t *exitTun) BatchSize() int         { return 1 }
func (t *exitTun) Read(buf [][]byte, sizes []int, offset int) (int, error) {
	view, ok := <-t.incoming
	if !ok {
		return 0, os.ErrClosed
	}
	n, err := view.Read(buf[0][offset:])
	if err != nil {
		return 0, err
	}
	sizes[0] = n
	return 1, nil
}
func (t *exitTun) Write(buf [][]byte, offset int) (int, error) {
	for _, b := range buf {
		packet := b[offset:]
		if len(packet) == 0 {
			continue
		}
		pkb := stack.NewPacketBuffer(stack.PacketBufferOptions{Payload: buffer.MakeWithData(packet)})
		if packet[0]>>4 == 4 {
			t.ep.InjectInbound(header.IPv4ProtocolNumber, pkb)
		}
	}
	return len(buf), nil
}
func (t *exitTun) WriteNotify() {
	pkt := t.ep.Read()
	if pkt == nil {
		return
	}
	view := pkt.ToView()
	pkt.DecRef()
	t.incoming <- view
}
func (t *exitTun) Close() error {
	t.stack.RemoveNIC(1)
	t.stack.Close()
	t.ep.RemoveNotify(t.notify)
	t.ep.Close()
	close(t.events)
	close(t.incoming)
	return nil
}

type ExitPeer struct {
	Peer
	tun       *exitTun
	localHTTP net.Listener
	resolver  string
	logMu     sync.Mutex
}

// StartExitPeer is StartPeer plus forwarding of every TCP/UDP flow to the real network.
func StartExitPeer(cfg PeerConfig, resolver string) (*ExitPeer, error) {
	tunnelIP, err := netip.ParseAddr(cfg.TunnelIP)
	if err != nil {
		return nil, fmt.Errorf("tunnel ip: %w", err)
	}
	_, portText, err := net.SplitHostPort(cfg.Listen)
	if err != nil {
		return nil, err
	}
	port, _ := strconv.Atoi(portText)
	priv, err := base64ToHex(cfg.PrivateKey)
	if err != nil {
		return nil, err
	}
	clientPub, err := base64ToHex(cfg.ClientPublicKey)
	if err != nil {
		return nil, err
	}
	if resolver == "" {
		resolver = "1.1.1.1:53"
	}
	ep := &ExitPeer{resolver: resolver}
	ep.cfg = cfg

	// Local HTTP server that still answers 10.66.0.1:80 (/hello, /blob) through the forwarder.
	httpListener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return nil, err
	}
	ep.localHTTP = httpListener
	mux := http.NewServeMux()
	mux.HandleFunc("/hello", func(w http.ResponseWriter, r *http.Request) { w.Write([]byte("hello from wg exit peer\n")) })
	mux.HandleFunc("/blob", func(w http.ResponseWriter, r *http.Request) {
		n, _ := strconv.Atoi(r.URL.Query().Get("bytes"))
		w.Header().Set("Content-Length", strconv.Itoa(n))
		chunk := make([]byte, 64*1024)
		for i := range chunk {
			chunk[i] = 0x5a
		}
		for n > 0 {
			k := len(chunk)
			if n < k {
				k = n
			}
			if _, err := w.Write(chunk[:k]); err != nil {
				return
			}
			n -= k
		}
	})
	go http.Serve(httpListener, mux)
	localHTTPPort := httpListener.Addr().(*net.TCPAddr).Port

	t := &exitTun{ep: channel.New(2048, 1420, ""), events: make(chan tun.Event, 10), incoming: make(chan *buffer.View, 64), mtu: 1420}
	t.stack = stack.New(stack.Options{
		NetworkProtocols:   []stack.NetworkProtocolFactory{ipv4.NewProtocol},
		TransportProtocols: []stack.TransportProtocolFactory{tcp.NewProtocol, udp.NewProtocol, icmp.NewProtocol4},
	})
	sack := tcpip.TCPSACKEnabled(true)
	t.stack.SetTransportProtocolOption(tcp.ProtocolNumber, &sack)
	t.notify = t.ep.AddNotify(t)
	if e := t.stack.CreateNIC(1, t.ep); e != nil {
		return nil, fmt.Errorf("CreateNIC: %v", e)
	}
	t.stack.AddProtocolAddress(1, tcpip.ProtocolAddress{Protocol: ipv4.ProtocolNumber, AddressWithPrefix: tcpip.AddrFromSlice(tunnelIP.AsSlice()).WithPrefix()}, stack.AddressProperties{})
	t.stack.AddRoute(tcpip.Route{Destination: header.IPv4EmptySubnet, NIC: 1})
	// Accept flows for any destination and answer from any source: this is the exit.
	t.stack.SetPromiscuousMode(1, true)
	t.stack.SetSpoofing(1, true)

	tcpFwd := tcp.NewForwarder(t.stack, 0, 2048, func(r *tcp.ForwarderRequest) {
		id := r.ID()
		target := net.JoinHostPort(id.LocalAddress.String(), strconv.Itoa(int(id.LocalPort)))
		if id.LocalAddress.String() == cfg.TunnelIP && id.LocalPort == 80 {
			target = "127.0.0.1:" + strconv.Itoa(localHTTPPort)
		}
		out, err := net.DialTimeout("tcp", target, 10*time.Second)
		if err != nil {
			ep.logf("tcp %s -> dial failed: %v", target, err)
			r.Complete(true)
			return
		}
		var wq waiter.Queue
		endpoint, e := r.CreateEndpoint(&wq)
		if e != nil {
			out.Close()
			r.Complete(true)
			return
		}
		r.Complete(false)
		in := gonet.NewTCPConn(&wq, endpoint)
		ep.logf("tcp %s <- %s:%d open", target, id.RemoteAddress, id.RemotePort)
		go func() { io.Copy(out, in); out.(*net.TCPConn).CloseWrite() }()
		go func() { io.Copy(in, out); in.Close(); out.Close() }()
	})
	t.stack.SetTransportProtocolHandler(tcp.ProtocolNumber, tcpFwd.HandlePacket)

	udpFwd := udp.NewForwarder(t.stack, func(r *udp.ForwarderRequest) {
		id := r.ID()
		target := net.JoinHostPort(id.LocalAddress.String(), strconv.Itoa(int(id.LocalPort)))
		if id.LocalAddress.String() == cfg.TunnelIP && id.LocalPort == 53 {
			target = resolver
		}
		var wq waiter.Queue
		endpoint, e := r.CreateEndpoint(&wq)
		if e != nil {
			return
		}
		in := gonet.NewUDPConn(&wq, endpoint)
		out, err := net.DialTimeout("udp", target, 5*time.Second)
		if err != nil {
			in.Close()
			return
		}
		idle := 60 * time.Second
		go func() {
			buf := make([]byte, 65535)
			for {
				in.SetReadDeadline(time.Now().Add(idle))
				n, err := in.Read(buf)
				if err != nil {
					break
				}
				if _, err := out.Write(buf[:n]); err != nil {
					break
				}
			}
			in.Close()
			out.Close()
		}()
		go func() {
			buf := make([]byte, 65535)
			for {
				out.SetReadDeadline(time.Now().Add(idle))
				n, err := out.Read(buf)
				if err != nil {
					break
				}
				if _, err := in.Write(buf[:n]); err != nil {
					break
				}
			}
			in.Close()
			out.Close()
		}()
	})
	t.stack.SetTransportProtocolHandler(udp.ProtocolNumber, udpFwd.HandlePacket)
	t.events <- tun.EventUp
	ep.tun = t

	logger := &device.Logger{Verbosef: func(string, ...any) {}, Errorf: func(format string, args ...any) { ep.logf("wg error: "+format, args...) }}
	dev := device.NewDevice(t, conn.NewDefaultBind(), logger)
	uapi := fmt.Sprintf("private_key=%s\nlisten_port=%d\npublic_key=%s\nallowed_ip=%s/32\n", priv, port, clientPub, cfg.ClientIP)
	if err := dev.IpcSet(uapi); err != nil {
		dev.Close()
		return nil, err
	}
	if err := dev.Up(); err != nil {
		dev.Close()
		return nil, err
	}
	state, _ := dev.IpcGet()
	for _, line := range strings.Split(state, "\n") {
		if strings.HasPrefix(line, "listen_port=") {
			ep.port, _ = strconv.Atoi(strings.TrimPrefix(line, "listen_port="))
		}
	}
	ep.dev = dev
	go ep.watchHandshake()
	ep.logf("exit peer listening on udp :%d; forwarding tunnel traffic to the internet (dns via %s)", ep.port, resolver)
	return ep, nil
}

func (e *ExitPeer) Close() error {
	if e.localHTTP != nil {
		e.localHTTP.Close()
	}
	if e.dev != nil {
		e.dev.Close()
	}
	return nil
}
