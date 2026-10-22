package main

import (
	"flag"
	"fmt"
	"os"
	"os/signal"
)

func usage() {
	fmt.Fprintln(os.Stderr, "usage: testpeer genkey | testpeer client -conf <wg.conf> [-url URL | -urls FILE] | testpeer serve -listen :51820 -private <b64> -peer <client public b64> [-ip 10.66.0.1] [-client 10.66.0.2]")
	os.Exit(2)
}

func main() {
	if len(os.Args) < 2 {
		usage()
	}
	switch os.Args[1] {
	case "genkey":
		keys, err := GenerateKeys()
		if err != nil {
			fmt.Fprintln(os.Stderr, err)
			os.Exit(1)
		}
		fmt.Printf("private=%s public=%s\n", keys.Private, keys.Public)
	case "client":
		runClient(os.Args[2:])
	case "serve":
		fs := flag.NewFlagSet("serve", flag.ExitOnError)
		listen := fs.String("listen", "0.0.0.0:51820", "UDP listen address")
		private := fs.String("private", "", "peer private key (base64)")
		clientPub := fs.String("peer", "", "client public key (base64)")
		ip := fs.String("ip", "10.66.0.1", "address served inside the tunnel")
		client := fs.String("client", "10.66.0.2", "client tunnel address")
		exit := fs.Bool("exit", false, "forward tunnel traffic to the real network (exit node mode)")
		resolver := fs.String("resolver", "1.1.1.1:53", "DNS server used for 10.66.0.1:53 in exit mode")
		fs.Parse(os.Args[2:])
		if *private == "" || *clientPub == "" {
			usage()
		}
		cfg := PeerConfig{Listen: *listen, PrivateKey: *private, ClientPublicKey: *clientPub, TunnelIP: *ip, ClientIP: *client, Stdout: true}
		var closer interface{ Close() error }
		if *exit {
			peer, err := StartExitPeer(cfg, *resolver)
			if err != nil {
				fmt.Fprintln(os.Stderr, err)
				os.Exit(1)
			}
			closer = peer
		} else {
			peer, err := StartPeer(cfg)
			if err != nil {
				fmt.Fprintln(os.Stderr, err)
				os.Exit(1)
			}
			closer = peer
		}
		stop := make(chan os.Signal, 1)
		signal.Notify(stop, os.Interrupt)
		<-stop
		closer.Close()
	default:
		usage()
	}
}
