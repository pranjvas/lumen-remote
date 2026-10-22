/* Mux link: one outbound TCP connection (extension socket) from the worker to
 * the Node service on 127.0.0.1:<port>. Frames: u8 type | u32be stream | u32be len | payload.
 * The service opens streams; each maps to an lwIP TCP pcb routed through wg0. */
#ifndef WG_MUX_H
#define WG_MUX_H

#include <stdint.h>

enum mux_type { MUX_OPEN = 1, MUX_OPENED = 2, MUX_DATA = 3, MUX_EOF = 4, MUX_RST = 5, MUX_CREDIT = 6, MUX_DNS = 7, MUX_DNSANSWER = 8, MUX_STATUS = 9, MUX_HELLO = 10 };

#define MUX_MAX_STREAMS 32
#define MUX_INITIAL_CREDIT (1024 * 1024) /* per stream; must match protocol/frames.js INITIAL_CREDIT. 64 KiB capped Proton downloads at ~3 Mbit/s over a 58 ms path. */
#define MUX_MAX_FRAME (256 * 1024)
#define MUX_CREDIT_GRANT 32768 /* grant consumed bytes back once this much is unacked; independent of the initial window so core and hub versions interoperate */
#define MUX_VERSION 1

/* Exported to JS: dial ip:port (dotted IPv4, normally 127.0.0.1) non-blocking. 0 ok, negative on immediate failure. */
int wg_mux_connect(const char *ip, uint16_t port);
/* Internal: called from wg_poll. Returns the mux socket fd (or -1) and whether POLLOUT is wanted. */
int wg_mux_fd(int *want_write);
/* Internal: service readable/writable events and periodic work. */
void wg_mux_service(int readable, int writable);
void wg_mux_close(void);
/* Internal: counters for status. */
void wg_mux_stats(int *linked, int *open_streams, uint32_t *frames_in, uint32_t *frames_out);

#endif
