/* The tunnel: lwIP + wireguard-lwip over one extension UDP socket.
 *
 * Underlay design. wireguard-lwip sends and receives its UDP datagrams through
 * an lwIP UDP pcb bound to a netif. We give it a tiny underlay netif `ul0`
 * (address 100.64.0.1/32, no ARP) whose output function strips the IP+UDP
 * headers lwIP just built and hands the WireGuard payload to the real socket
 * (udp_transport). Incoming datagrams are wrapped back into a minimal IP+UDP
 * packet addressed to ul0 and pushed through ip4_input, which delivers them to
 * the same pcb. The encapsulation costs 28 bytes of memcpy per packet and keeps
 * the vendored wireguard-lwip untouched. The WireGuard netif `wg0` is the lwIP
 * default route, so every TCP/UDP/DNS pcb the mux opens goes through the tunnel. */
#ifndef WG_TUNNEL_H
#define WG_TUNNEL_H

#include <stdint.h>

/* Exported to JS. Return 0 on success or a negative code (wg_config_error for config problems, -100.. for runtime). */
int wg_start(const char *conf_text);
/* One scheduler iteration: waits up to timeout_ms for socket readiness, pumps packets and lwIP timers. */
int wg_poll(int timeout_ms);
void wg_stop(void);
/* Writes status JSON (never keys) into json_out. 0 ok, -1 on buffer too small. */
int wg_status(char *json_out, int cap);

/* Internal: used by the mux (Task 6). */
struct netif *wg_tunnel_netif(void);
int wg_tunnel_is_up(void);
void wg_tunnel_set_error(const char *text);

#endif
