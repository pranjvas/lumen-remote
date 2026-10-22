/* Parser for the wg-quick subset Proton VPN emits in its WireGuard .conf files. */
#ifndef WG_CONFIG_H
#define WG_CONFIG_H

#include <stdint.h>
#include <stdbool.h>

enum wg_config_error {
  WG_CONFIG_OK = 0,
  WG_CONFIG_BAD_ARGS = -1,
  WG_CONFIG_NO_PRIVATE_KEY = -2,
  WG_CONFIG_BAD_KEY = -3,
  WG_CONFIG_BAD_ENDPOINT = -4,
  WG_CONFIG_NO_PUBLIC_KEY = -5,
  WG_CONFIG_NO_ADDRESS = -6,
  WG_CONFIG_TOO_LONG = -7,
};

struct wg_config {
  char private_key_b64[48];      /* wireguardif wants base64 strings */
  char peer_public_key_b64[48];
  uint8_t private_key[32];
  uint8_t peer_public_key[32];
  uint8_t preshared_key[32];
  bool has_psk;
  char address[16];              /* dotted IPv4, mask dropped */
  char dns[16];                  /* dotted IPv4 or "" */
  char endpoint_host[256];       /* hostname or dotted IPv4 */
  uint16_t endpoint_port;
  uint16_t keepalive;            /* 0 = none */
  bool allows_default_route;     /* AllowedIPs contains 0.0.0.0/0 */
};

/* Returns WG_CONFIG_OK or a negative wg_config_error. */
int wg_config_parse_into(const char *text, struct wg_config *out);

/* Exported to JS: parses and writes a key-free JSON summary into json_out. */
int wg_config_parse(const char *text, char *json_out, int cap);

/* Decodes standard base64 (with padding). Returns bytes written or -1. */
int wg_base64_decode(const char *text, uint8_t *out, int cap);

#endif
