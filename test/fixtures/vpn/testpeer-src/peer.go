package main

// Userspace WireGuard test peer: no driver, no root. It answers the TV-side
// tunnel's handshake and serves HTTP and DNS inside the tunnel so the whole
// CineHD tunnel path can be exercised offline and deterministically.

import (
	"crypto/rand"
	"encoding/base64"
	"encoding/binary"
	"encoding/hex"
	"errors"
	"fmt"
	"net"
	"net/http"
	"net/netip"
	"strconv"
	"strings"
	"sync"
	"time"

	"golang.org/x/crypto/curve25519"
	"golang.zx2c4.com/wireguard/conn"
	"golang.zx2c4.com/wireguard/device"
	"golang.zx2c4.com/wireguard/tun/netstack"
)

type Keys struct{ Private, Public string }

// GenerateKeys returns a fresh base64 X25519 key pair in wg(8) format.
func GenerateKeys() (Keys, error) {
	var priv [32]byte
	if _, err := rand.Read(priv[:]); err != nil {
		return Keys{}, err
	}
	priv[0] &= 248
	priv[31] &= 127
	priv[31] |= 64
	pub, err := curve25519.X25519(priv[:], curve25519.Basepoint)
	if err != nil {
		return Keys{}, err
	}
	return Keys{Private: base64.StdEncoding.EncodeToString(priv[:]), Public: base64.StdEncoding.EncodeToString(pub)}, nil
}

func base64ToHex(key string) (string, error) {
	raw, err := base64.StdEncoding.DecodeString(strings.TrimSpace(key))
	if err != nil || len(raw) != 32 {
		return "", errors.New("key must be 32 bytes of base64")
	}
	return hex.EncodeToString(raw), nil
}

type PeerConfig struct {
	Listen          string // "host:port"; port 0 picks a free port
	PrivateKey      string // base64
	ClientPublicKey string // base64
	TunnelIP        string // address served inside the tunnel, e.g. 10.66.0.1
	ClientIP        string // the client's tunnel address, e.g. 10.66.0.2
	Stdout          bool   // also print log lines to stdout
}

type Peer struct {
	dev  *device.Device
	tnet *netstack.Net
	port int
	mu   sync.Mutex
	log  strings.Builder
	cfg  PeerConfig
	http *http.Server
	dns  net.PacketConn
}

func (p *Peer) logf(format string, args ...any) {
	line := fmt.Sprintf(format, args...)
	p.mu.Lock()
	p.log.WriteString(line + "\n")
	p.mu.Unlock()
	if p.cfg.Stdout {
		fmt.Println(line)
	}
}

func (p *Peer) Log() string { p.mu.Lock(); defer p.mu.Unlock(); return p.log.String() }

func (p *Peer) ListenPort() int { return p.port }

func StartPeer(cfg PeerConfig) (*Peer, error) {
	tunnelIP, err := netip.ParseAddr(cfg.TunnelIP)
	if err != nil {
		return nil, fmt.Errorf("tunnel ip: %w", err)
	}
	if _, err := netip.ParseAddr(cfg.ClientIP); err != nil {
		return nil, fmt.Errorf("client ip: %w", err)
	}
	host, portText, err := net.SplitHostPort(cfg.Listen)
	if err != nil {
		return nil, fmt.Errorf("listen: %w", err)
	}
	port, _ := strconv.Atoi(portText)
	priv, err := base64ToHex(cfg.PrivateKey)
	if err != nil {
		return nil, fmt.Errorf("private key: %w", err)
	}
	clientPub, err := base64ToHex(cfg.ClientPublicKey)
	if err != nil {
		return nil, fmt.Errorf("client public key: %w", err)
	}
	p := &Peer{cfg: cfg}
	tun, tnet, err := netstack.CreateNetTUN([]netip.Addr{tunnelIP}, []netip.Addr{tunnelIP}, 1420)
	if err != nil {
		return nil, err
	}
	logger := &device.Logger{
		Verbosef: func(format string, args ...any) {
			msg := fmt.Sprintf(format, args...)
			if strings.Contains(msg, "Received handshake initiation") {
				p.logf("handshake ok")
			}
		},
		Errorf: func(format string, args ...any) { p.logf("wg error: "+format, args...) },
	}
	dev := device.NewDevice(tun, conn.NewDefaultBind(), logger)
	_ = host
	uapi := fmt.Sprintf("private_key=%s\nlisten_port=%d\npublic_key=%s\nallowed_ip=%s/32\n", priv, port, clientPub, cfg.ClientIP)
	if err := dev.IpcSet(uapi); err != nil {
		dev.Close()
		return nil, err
	}
	if err := dev.Up(); err != nil {
		dev.Close()
		return nil, err
	}
	state, err := dev.IpcGet()
	if err != nil {
		dev.Close()
		return nil, err
	}
	for _, line := range strings.Split(state, "\n") {
		if strings.HasPrefix(line, "listen_port=") {
			p.port, _ = strconv.Atoi(strings.TrimPrefix(line, "listen_port="))
		}
	}
	p.dev, p.tnet = dev, tnet

	listener, err := tnet.ListenTCP(&net.TCPAddr{IP: tunnelIP.AsSlice(), Port: 80})
	if err != nil {
		dev.Close()
		return nil, err
	}
	mux := http.NewServeMux()
	mux.HandleFunc("/hello", func(w http.ResponseWriter, r *http.Request) { w.Write([]byte("hello from wg peer\n")) })
	mux.HandleFunc("/blob", func(w http.ResponseWriter, r *http.Request) {
		n, err := strconv.Atoi(r.URL.Query().Get("bytes"))
		if err != nil || n < 0 || n > 1<<30 {
			http.Error(w, "bytes must be 0..1GiB", 400)
			return
		}
		w.Header().Set("Content-Type", "application/octet-stream")
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
	p.http = &http.Server{Handler: mux}
	go p.http.Serve(listener)

	dnsConn, err := tnet.ListenUDP(&net.UDPAddr{IP: tunnelIP.AsSlice(), Port: 53})
	if err != nil {
		p.Close()
		return nil, err
	}
	p.dns = dnsConn
	go p.serveDNS(dnsConn, tunnelIP)
	go p.watchHandshake()
	p.logf("listening on udp :%d, http %s:80, dns %s:53", p.port, cfg.TunnelIP, cfg.TunnelIP)
	return p, nil
}

// watchHandshake logs "handshake ok" once the peer's last_handshake_time becomes non-zero
// (read through the UAPI, which is reliable regardless of logger verbosity).
func (p *Peer) watchHandshake() {
	for {
		time.Sleep(100 * time.Millisecond)
		state, err := p.dev.IpcGet()
		if err != nil {
			return
		}
		for _, line := range strings.Split(state, "\n") {
			if strings.HasPrefix(line, "last_handshake_time_sec=") && strings.TrimPrefix(line, "last_handshake_time_sec=") != "0" {
				p.logf("handshake ok")
				return
			}
		}
	}
}

// serveDNS answers every A question with the tunnel address; other types get an empty answer.
func (p *Peer) serveDNS(c net.PacketConn, answer netip.Addr) {
	buf := make([]byte, 1500)
	for {
		n, from, err := c.ReadFrom(buf)
		if err != nil {
			return
		}
		q := buf[:n]
		if len(q) < 12 {
			continue
		}
		// question: labels until 0, then qtype(2) qclass(2)
		i := 12
		for i < len(q) && q[i] != 0 {
			i += int(q[i]) + 1
		}
		if i+5 > len(q) {
			continue
		}
		qtype := binary.BigEndian.Uint16(q[i+1:])
		question := q[12 : i+5]
		resp := make([]byte, 0, 12+len(question)+16)
		resp = append(resp, q[0], q[1], 0x81, 0x80, 0, 1, 0, 0, 0, 0, 0, 0)
		resp = append(resp, question...)
		if qtype == 1 {
			resp[7] = 1
			ip := answer.As4()
			resp = append(resp, 0xC0, 0x0C, 0, 1, 0, 1, 0, 0, 0, 60, 0, 4, ip[0], ip[1], ip[2], ip[3])
		}
		c.WriteTo(resp, from)
	}
}

func (p *Peer) Close() error {
	if p.dns != nil {
		p.dns.Close()
	}
	if p.http != nil {
		p.http.Close()
	}
	if p.dev != nil {
		p.dev.Close()
	}
	return nil
}
