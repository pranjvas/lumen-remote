/* lwIP options for the CineHD WireGuard core: single-threaded (NO_SYS), raw API
 * only, IPv4 only, TCP client + UDP + DNS inside the tunnel. The wasm heap is
 * cheap, so buffers are sized for a few megabytes in flight. */
#ifndef WG_LWIPOPTS_H
#define WG_LWIPOPTS_H

#define NO_SYS                          1
#define SYS_LIGHTWEIGHT_PROT            0
#define LWIP_TIMERS                     1
#define LWIP_SOCKET                     0
#define LWIP_NETCONN                    0
#define LWIP_NETIF_API                  0
#define LWIP_COMPAT_SOCKETS             0

#define LWIP_IPV4                       1
#define LWIP_IPV6                       0
#define LWIP_ARP                        0
#define LWIP_ETHERNET                   0
#define LWIP_DHCP                       0
#define LWIP_AUTOIP                     0
#define LWIP_ACD                        0
#define LWIP_IGMP                       0
#define LWIP_ICMP                       1
#define LWIP_RAW                        0
#define LWIP_UDP                        1
#define LWIP_TCP                        1
#define LWIP_DNS                        1
#define LWIP_ALTCP                      0
#define LWIP_NETIF_STATUS_CALLBACK      1
#define LWIP_NETIF_LINK_CALLBACK        1
#define LWIP_NETIF_HOSTNAME             0
#define LWIP_STATS                      0
#define IP_FORWARD                      0
#define IP_REASSEMBLY                   1
#define IP_FRAG                         1

#define MEM_ALIGNMENT                   4
#define MEM_SIZE                        (8 * 1024 * 1024)
#define MEMP_NUM_PBUF                   256
#define MEMP_NUM_UDP_PCB                8
#define MEMP_NUM_TCP_PCB                192
#define MEMP_NUM_TCP_PCB_LISTEN         2
#define MEMP_NUM_TCP_SEG                4096
#define MEMP_NUM_SYS_TIMEOUT            16
#define PBUF_POOL_SIZE                  4096
#define PBUF_POOL_BUFSIZE               1536

#define TCP_MSS                         1380
#define TCP_WND                         (512 * TCP_MSS) /* ~706 KB: 100 Mbit/s at 60 ms RTT needs ~750 KB in flight */
#define TCP_SND_BUF                     (64 * TCP_MSS)
#define TCP_SND_QUEUELEN                256
#define TCP_OVERSIZE                    TCP_MSS
#define TCP_QUEUE_OOSEQ                 1
#define LWIP_TCP_SACK_OUT               1
#define LWIP_WND_SCALE                  1
#define TCP_RCV_SCALE                   4
#define TCP_LISTEN_BACKLOG              0

#define DNS_TABLE_SIZE                  8
#define DNS_MAX_NAME_LENGTH             256
#define DNS_MAX_SERVERS                 2

#define CHECKSUM_GEN_IP                 1
#define CHECKSUM_GEN_UDP                1
#define CHECKSUM_GEN_TCP                1
#define CHECKSUM_CHECK_IP               1
#define CHECKSUM_CHECK_UDP              1
#define CHECKSUM_CHECK_TCP              1

#define LWIP_DEBUG                      0
#define LWIP_NOASSERT                   0

unsigned int wg_rand32(void);
#define LWIP_RAND()                     wg_rand32()

#endif
