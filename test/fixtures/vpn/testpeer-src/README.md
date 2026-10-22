# testpeer - userspace WireGuard test peer

Plays the "Proton server" role on the PC for tunnel tests. Pure userspace
(`golang.zx2c4.com/wireguard` + `tun/netstack`): no driver, no admin rights.

```
go build -o ../../bin/testpeer.exe .     # from this directory
testpeer genkey                           # private=<b64> public=<b64>
testpeer serve -listen 0.0.0.0:51820 -private <server private> -peer <client public> [-ip 10.66.0.1] [-client 10.66.0.2]
```

Inside the tunnel it serves:

- `http://10.66.0.1/hello` -> `hello from wg peer\n`
- `http://10.66.0.1/blob?bytes=N` -> N bytes of `0x5a` (throughput tests)
- UDP DNS on `10.66.0.1:53`: every `A` question answers `10.66.0.1`

It prints `handshake ok` when the first handshake initiation from the client
arrives. Keys are generated per test run; none are committed.
