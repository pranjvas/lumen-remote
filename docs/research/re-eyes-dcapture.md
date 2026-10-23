# Lumen Eyes: seeing the TV screen without extra hardware

Live on the Q95T (2026-10-23). A public-certificate Tizen .NET app captures the composited screen
(video plus the UI layer: Smart Hub, menus, app screens, subtitles) in about 40–80 ms, with no camera,
no partner certificate and no `privilege/screenshot`.

## How

`libdisplay-capture-api.so.0` (the client library of `display-capture-service`) captures **in
process**: `ppicapture()` → `libvideo-capture.so` (`IVideoCapture`, `secvideo_api_capture_*`) →
`DRM_IOCTL_SDP_HW_CAPTURE` on `/dev/dri/card1`. D-Bus is only used afterwards to announce
`CaptureComplete`. An app process (uid 5001, SMACK `User::Pkg::org.lumen.eyes`) can open
`/dev/dri/card1` read-write, so calling the library from the app works. The on-TV research agent's
"no pixels at public level" verdict (`re-eyes-on-tv.md`) only covered the screenshot privilege and
the Wayland screenshooter, not this path.

Recovered from the emulator's i386 build of the library (unstripped; objdump), confirmed on the
armv7 TV:

- `int ppicapture(RequestedData*, unsigned char* ybuf, unsigned char* cbuf, int bufsize)`,
  mangled `_Z10ppicaptureP13RequestedDataPhS1_i`, returns 0 on success.
- `RequestedData` (as `m_capture_to_file_sync` builds it): `+0x00` width, `+0x04` height (requested,
  then the captured size), `+0x08` 0x20, `+0x0c` Y size, `+0x10` C size, `+0x14` Y pointer, `+0x18`
  C pointer, `+0x1c` mode (0–4; 3 and 4 return -1), `+0x20` 0, `+0x24` colour format (in 2, out 1 =
  YUV420 semi-planar, i.e. NV12), `+0x28` 6 (in).
- The library's own buffers are 0x7e900 bytes, and the capture comes back at 720x540 (720x576 when
  asked for more). The frame is the 16:9 screen squeezed into 4:3, so Lumen stretches it to 960x540.
- Mode 0 is the composited screen (video and graphics). Modes 1 and 2 also returned the video;
  Lumen uses 0.
- Netflix playback was **not** blanked (Friends captured mid-episode). HDCP sources may still be:
  the library logs `HDCP Source` and `protected_on`.
- `dc_request_capture_to_file_sync` (struct: app_type 4 = SOURCE, mode, comp 0 = PNG / 1 = JPEG,
  quality, dir, name, width, height, ret_w, ret_h, ret_path[256]) captures too, but its JPEG/PNG
  writer uses a temp file under the capture service's own directory, which an app cannot write, so
  it returns 1 with no file. Lumen skips it and encodes on the PC.

## In Lumen

- `companion/eyes` (`org.lumen.eyes`, windowless .NET UI app, Tizen.NET.Sdk 1.1.9, `tizen50`):
  build with `tools/eyes/build.ps1`, install with `tools/eyes/install.sh`.
- `server/adapters/eyes.js`: on the first capture it asks the TV agent to launch the app with
  app-control extra `lumen` = `ws://<pc>:<lanPort>/eyes?key=<agentKey>`; the app dials out and
  answers `{t:'capture', id, mode}` with `[u32 header length][header JSON][NV12]`.
  `server/util/image.js` converts the frame to a 960x540 PNG.
- Hub command `screen.capture`, `GET /api/screen.png` (latest frame, `no-store`), and the AI tool
  `look_at_screen`, which returns the PNG as image content so Claude can drive any app by sight.

## Limits and open questions

- 720x540 source resolution: large text is readable, very small text is not.
- No sdb shell on this TV (`intershell_support:disabled`), so device logs (dlog) are not readable.
- Whether the app survives for hours in the background is untested; Lumen relaunches it on demand.
