# Reverse engineering: dlna-cast

## Summary

The Q95T's DMR at :9197 accepts standard UPnP AV cast, and its Sink list is broad (292 http-get entries, 34 MIME types, live today). It names some types differently from common practice: mkv must be video/x-mkv, flac audio/x-flac, wav audio/x-wav, ADTS AAC audio/vnd.dlna.adts. Plain 188-byte .ts maps to video/mpeg (the *_ISO profiles); video/vnd.dlna.mpeg-tts is for 192-byte M2TS. The Sink has NO video/x-matroska, audio/flac, audio/aac, video/mp2t, image/gif, image/webp or any *mpegurl (HLS) entry.

The TV's DMR binary (vd_dmr) is not in the Tizen 5.5 emulator image (its unit symlink is dangling). The player stack it uses is there, and I decompiled it with objdump; REA's Ghidra provider only accepts PE files on Windows.
- libmmfplayer (mm-player) chooses the source from the URI. A 'dlna://' prefix goes to the dlnasrc/DLNA reader. Plain http(s) goes to mmhttpsrc/souphttpsrc. '.m3u8' or 'format=m3u8-aapl' goes to the HLS demuxer.
- The DLNA reader (libDlnaReaderCore) always sends a HEAD first, then a GET. Both are HTTP/1.0 or 1.1 with 'Connection: close', no User-Agent, and these headers: getcontentFeatures.dlna.org: 1, transferMode.dlna.org: Streaming|Interactive, getCaptionInfo.sec: 1, getMediaInfo.sec: 1, getAvailableSeekRange.dlna.org: 1, and Range: bytes=N- / TimeSeekRange.dlna.org: npt= / PlaySpeed.dlna.org.
- ReaderClient::Open aborts if the HEAD fails; there is no GET fallback.
- CheckHTTPResult accepts only 100, 200-202, 206 and 207-299, so any 3xx redirect or 4xx/5xx is a failure.
- From the response it parses content-length, chunked transfer-encoding, transferMode.dlna.org, content-type, contentFeatures.dlna.org (DLNA.ORG_OP digit 1 = time seek, digit 2 = byte seek; also PN, FLAGS, PS, CI), content-range, TimeSeekRange.dlna.org, availableSeekRange.dlna.org, and two Samsung headers: CaptionInfo.sec (an SRT URL) and MediaInfo.sec ('SEC_Duration=<int>;', parsed with strtoll; probably milliseconds).
- An unknown Content-Type is not fatal; only RealMedia is rejected outright.

So Lumen's media server should: answer HEAD with 200 and full headers; honour single Range requests (206, and 416 when out of range); send Content-Type using the TV's own names, Accept-Ranges, 'contentFeatures.dlna.org: DLNA.ORG_OP=01;DLNA.ORG_CI=0;DLNA.ORG_FLAGS=01700000000000000000000000000000' (images: FLAGS=00F00000...), and transferMode echoed from the request (Interactive for images); never redirect; and cast the final URL after following any redirect itself.

SetAVTransportURI recipe. It is shown to work on a 2025 Samsung DMR by awake-devel/tv-remote, and the live SCPD has every action it uses:
1. Stop (ignore errors).
2. SetAVTransportURI with InstanceID 0, the URI, and a DIDL-Lite item (id=0, parentID=-1, restricted=1) holding dc:title, upnp:class (object.item.videoItem.movie / audioItem.musicTrack / imageItem.photo) and <res protocolInfo='http-get:*:MIME:DLNA flags'>. The DIDL is escaped twice in total.
3. Play with Speed 1, retried every 0.5 s while the TV answers 705 'Transport is locked' or 701.
4. Seek with Unit REL_TIME and Target 'H:MM:SS'. Clamp to duration minus 1 s (the TV gives 711 at the exact end), and retry 701 for about 0.2 s after a seek.
5. Poll GetTransportInfo + GetPositionInfo at 1 Hz. The AVTransport GENA LastChange (seen earlier today) carries TransportState, CurrentTrackDuration and CurrentTransportActions but not RelTime, so it can replace the state poll but not the position poll.
6. Images report PLAYING at 0:00 indefinitely. Treat a cast as ended only after PLAYING was seen and then STOPPED/NO_MEDIA_PRESENT; treat it as never-started after 30 s.

ProductCap is 'Tizen,Y2020,WebURIPlayable,NavigateInPause,...,UHD_SCREEN,...,vdProductType=TV,OCF=1' (identifiers redacted). Samsung's own control point (libasfmediasharecp DeviceAbilityTable) maps the tokens weburiplayable, navigateinpause and seektrack_nr to ability flags. Inferred meaning: WebURIPlayable = the TV fetches arbitrary internet URLs itself (the souphttpsrc path, which supports https and follows redirects); NavigateInPause = Seek is allowed while paused; there is no SeekTRACK_NR.

Samsung extensions in the live SCPDs:
- AVTransport: X_PlayerAppHint(UpnpClass object.item.imageItem|audioItem|videoItem, PlayerHint load|unload), X_PrefetchURI, X_GetStoppedReason, X_DLNA_GetBytePositionInfo, SetNextAVTransportURI. Seek modes: TRACK_NR|REL_TIME|ABS_TIME|ABS_COUNT|REL_COUNT|X_DLNA_REL_BYTE.
- RenderingControl: X_ControlCaption(Enable|Disable, ...), X_SetAspectRatio(Default|FitScreen), X_SetZoom, X_SetTVSlideShow/X_GetTVSlideShow, X_Move/Zoom/Origin360View.
- TransportPlaySpeed has no allowed-value list. Use Speed=1 only: the TV's DLNA reader sends PlaySpeed.dlna.org only when the server advertises DLNA.ORG_PS.

Gaps in the existing Lumen code (server/features/cast.js, server/adapters/avtransport.js):
- MIME_BY_EXT uses video/x-matroska, audio/flac, audio/wav, audio/aac and video/mp2t, which are absent from the TV Sink, and offers gif/webp/m3u8.
- classify() follows redirects in its probe but casts the original URL.
- The probe has no GET fallback when HEAD is refused.
- Play has no 705 retry, and nothing is stopped before SetAVTransportURI.
- Seek clamps to the full duration (711 at the end).
- Images use the streaming DLNA flags.

Files are under C:/Users/pranj/AppData/Local/Temp/tvremote-re/dlna-cast/:
- sketch/dlna-cast.mjs: the module.
- sketch/mock-test.mjs: a loopback self-test with a mock DMR that issues reader-style HEAD then GET. It passes and made no TV contact.
- sketch/cast-test.mjs: the supervised harness for the orchestrator. It refuses to run without --supervised and LUMEN_SUPERVISED=yes, logs every TV fetch with all its headers, and logs state at 1 Hz.
- media/: test clips (H.264, HEVC, MKV, VP9 WebM, 10 s each, video only, moov at the front), the Earthrise JPEG, a 1080p PNG test card and a WAV tone.
- live/: today's redacted live probe outputs (SCPDs, GetProtocolInfo Sink list in sink.txt, getter responses in soap.json).

## Verified live

- 2026-10-21 ~19:15 IST, one read-only session of 9.3 s, 600 ms spacing. REST PowerState was 'on' first. HTTP GET /dmr, /AVTransport_1.xml, /ConnectionManager_1.xml and /RenderingControl_1.xml all returned 200 text/xml (3258/21835/6342/15378 bytes, 8-27 ms). Server header: 'SHP, UPnP/1.0, Samsung UPnP SDK/1.0'. DLNA DMR-1.50, modelName QA55Q95TAKXXL, modelNumber AllShare1.0.
- ProductCap (identifiers redacted): Tizen,Y2020,WebURIPlayable,NavigateInPause,ScreenMirroringP2PMAC=<redacted>,UHD_SCREEN,SerialNumber=<redacted>,vdProductType=TV,OCF=1. No SeekTRACK_NR.
- ConnectionManager GetProtocolInfo: Source is empty. Sink has 292 http-get entries across 34 MIME types. Profiled entries carry DLNA.ORG_PN and DLNA.ORG_FLAGS=ED100000... (video) or 8D100000... (audio/LPCM). Wildcard entries 'http-get:*:<mime>:*' exist for image/jpeg, image/png, image/bmp, image/mpo, audio/mpeg, audio/x-ms-wma, audio/mp4, audio/x-m4a, audio/3ga, audio/ogg, audio/x-wav, audio/x-flac, smi/caption, video/x-msvideo, video/x-ms-asf, video/x-divx, video/x-ms-wmv, video/x-mkv, video/quicktime, video/mp4, video/hevc, video/x-avi, video/avi, video/x-flv, video/mpeg, video/mpeg2, video/3gpp, video/webm. Also present: video/vnd.dlna.mpeg-tts (95 PNs), audio/vnd.dlna.adts, audio/L16 (LPCM), audio/vnd.dolby.dd-raw (AC3), audio/x-sony-oma. NOT present: any mpegurl/HLS type, video/x-matroska, video/mp2t, audio/flac, audio/wav, audio/aac, image/gif, image/webp.
- GetCurrentConnectionIDs = 0. GetCurrentConnectionInfo(0) = RcsID 0, AVTransportID 0, ProtocolInfo empty, PeerConnectionID -1, Direction Input, Status Unknown.
- AVTransport idle state: GetTransportInfo = NO_MEDIA_PRESENT / OK / Speed 1. GetMediaInfo = NrTracks 0, MediaDuration '0:00:00' (single-digit hour format), empty URIs, PlayMedium 'NETWORK,NONE', RecordMedium/WriteStatus NOT_IMPLEMENTED. GetPositionInfo = Track 0, TrackDuration/RelTime/AbsTime '0:00:00', RelCount/AbsCount 2147483647. GetDeviceCapabilities = PlayMedia 'NETWORK,NONE', Rec* NOT_IMPLEMENTED. GetCurrentTransportActions = '' (empty). GetTransportSettings = NORMAL / NOT_IMPLEMENTED. X_GetStoppedReason = '' / ''. RenderingControl X_GetServiceCapabilities = 'GetVolume,SetVolume,GetMute,SetMute'.
- AVTransport SCPD (live): actions are Play(Speed), Stop, Next, Previous, SetPlayMode(NORMAL only), GetMediaInfo, GetDeviceCapabilities, SetAVTransportURI, SetNextAVTransportURI, X_PrefetchURI(PrefetchURI, PrefetchURIMetaData), GetTransportSettings, GetTransportInfo, Pause, Seek(Unit, Target), GetPositionInfo, GetCurrentTransportActions, X_DLNA_GetBytePositionInfo, X_GetStoppedReason, X_PlayerAppHint(UpnpClass, PlayerHint). SeekMode allowed values: TRACK_NR|REL_TIME|ABS_TIME|ABS_COUNT|REL_COUNT|X_DLNA_REL_BYTE. X_ARG_TYPE_UpnpClass: object.item.imageItem|object.item.audioItem|object.item.videoItem. X_ARG_TYPE_PlayerHint: load|unload. TransportPlaySpeed is a string with no allowed list. Only LastChange is evented.
- RenderingControl SCPD (live) Samsung extras: X_GetAspectRatio/X_SetAspectRatio (Default|FitScreen); X_ControlCaption(Operation Enable|Disable, Name, ResourceURI, CaptionURI, CaptionType, Language, Encoding); X_GetCaptionState; X_SetZoom(x,y,w,h); X_GetTVSlideShow/X_SetTVSlideShow(CurrentShowState boolean, CurrentShowTheme); X_Move360View/X_Zoom360View/X_Origin360View. ConnectionStatus values: OK|ContentFormatMismatch|InsufficientBandwidth|UnreliableChannel|Unknown.
- Recorded earlier today (local-services research, not re-run by me): the AVTransport GENA initial NOTIFY LastChange carries 22 variables (TransportState, TransportStatus, TransportPlaySpeed, AVTransportURI(+MetaData), CurrentTrackURI/Duration/MetaData, CurrentMediaDuration, CurrentTransportActions, NextAVTransportURI, NumberOfTracks, PlaybackStorageMedium, ...). RelativeTimePosition is not among them.

## Recipes

### List formats the TV accepts (Sink)

- evidence: live-tv; needs live launch test: false
- request: POST http://192.168.1.2:9197/upnp/control/ConnectionManager1
Content-Type: text/xml; charset="utf-8"
SOAPACTION: "urn:schemas-upnp-org:service:ConnectionManager:1#GetProtocolInfo"

<?xml version="1.0" encoding="utf-8"?><s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/"><s:Body><u:GetProtocolInfo xmlns:u="urn:schemas-upnp-org:service:ConnectionManager:1"></u:GetProtocolInfo></s:Body></s:Envelope>
- expected: 200 in ~14 ms, 29 KB. <Source></Source> plus <Sink> with 292 comma-separated 'http-get:*:<mime>:<4th field>' entries (list in live/sink.txt). Use sinkEntries(sink, mime) to check a MIME before casting. Cache it; it does not change.

### Poll cast state (state at 1 Hz; also usable as a cheap idle check)

- evidence: live-tv; needs live launch test: false
- request: POST /upnp/control/AVTransport1, SOAPACTION "urn:schemas-upnp-org:service:AVTransport:1#GetTransportInfo", body <u:GetTransportInfo xmlns:u="urn:schemas-upnp-org:service:AVTransport:1"><InstanceID>0</InstanceID></u:GetTransportInfo>. Same pattern with #GetPositionInfo, #GetMediaInfo, #GetCurrentTransportActions, #GetDeviceCapabilities, #X_GetStoppedReason (all take only InstanceID 0).
- expected: Idle: CurrentTransportState NO_MEDIA_PRESENT, Status OK, Speed 1. Values are newline-terminated, so trim them. Times use 'H:MM:SS' (e.g. 0:00:00); parse optional .fff. RelCount 2147483647 = not implemented. During a cast: TRANSITIONING then PLAYING/PAUSED_PLAYBACK; Actions lists e.g. Play,Pause,Stop,Seek; TrackDuration > 0 once known. AVTransport GENA (SUBSCRIBE /upnp/event/AVTransport1, NOTIFY LastChange) can replace the state poll, but RelTime must still be polled.

### Cast a video file served by Lumen (primary recipe)

- evidence: source-code; needs live launch test: true
- request: Optional first step: Stop (ignore errors) if the state is PLAYING/PAUSED_PLAYBACK/TRANSITIONING.
POST http://192.168.1.2:9197/upnp/control/AVTransport1
Content-Type: text/xml; charset="utf-8"
SOAPACTION: "urn:schemas-upnp-org:service:AVTransport:1#SetAVTransportURI"

<?xml version="1.0" encoding="utf-8"?><s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/"><s:Body><u:SetAVTransportURI xmlns:u="urn:schemas-upnp-org:service:AVTransport:1"><InstanceID>0</InstanceID><CurrentURI>http://192.168.1.7:PORT/m/t1/clip.mp4</CurrentURI><CurrentURIMetaData>&lt;DIDL-Lite xmlns=&quot;urn:schemas-upnp-org:metadata-1-0/DIDL-Lite/&quot; xmlns:dc=&quot;http://purl.org/dc/elements/1.1/&quot; xmlns:upnp=&quot;urn:schemas-upnp-org:metadata-1-0/upnp/&quot; xmlns:dlna=&quot;urn:schemas-dlna-org:metadata-1-0/&quot;&gt;&lt;item id=&quot;0&quot; parentID=&quot;-1&quot; restricted=&quot;1&quot;&gt;&lt;dc:title&gt;Lumen T1&lt;/dc:title&gt;&lt;upnp:class&gt;object.item.videoItem.movie&lt;/upnp:class&gt;&lt;res protocolInfo=&quot;http-get:*:video/mp4:DLNA.ORG_OP=01;DLNA.ORG_CI=0;DLNA.ORG_FLAGS=01700000000000000000000000000000&quot;&gt;http://192.168.1.7:PORT/m/t1/clip.mp4&lt;/res&gt;&lt;/item&gt;&lt;/DIDL-Lite&gt;</CurrentURIMetaData></u:SetAVTransportURI></s:Body></s:Envelope>
then #Play with <InstanceID>0</InstanceID><Speed>1</Speed>, retried every 500 ms (up to 20 times) while the fault is 705 'Transport is locked' or 701.
- expected: SetAVTransportURI 200 (state STOPPED). Play may return 705 for a moment, then 200. The TV fetches the URL within about 1 s: the dlnasrc path sends HEAD (no User-Agent, getcontentFeatures.dlna.org: 1, transferMode Streaming, getCaptionInfo.sec, getMediaInfo.sec, Connection: close), then GET with Range: bytes=0-. State goes TRANSITIONING then PLAYING. Failure codes: 714 illegal MIME, 716 resource not found, 704 format not supported, 701 transition not available.

### Media-server HTTP contract the TV's DLNA reader needs

- evidence: decompiled; needs live launch test: true
- request: For HEAD and GET /m/<id>/<name>: status 200 (or 206 when Range is present; 416 with 'Content-Range: bytes */SIZE' when out of range).
Headers: Content-Type: <TV MIME name>; Content-Length; Accept-Ranges: bytes; Content-Range: bytes S-E/SIZE (206); contentFeatures.dlna.org: DLNA.ORG_OP=01;DLNA.ORG_CI=0;DLNA.ORG_FLAGS=01700000000000000000000000000000 (images: ...FLAGS=00F00000000000000000000000000000); transferMode.dlna.org: <echo request: Streaming|Interactive|Background; default Interactive for images, else Streaming>.
Optional: MediaInfo.sec: SEC_Duration=<ms>; (when the request has getMediaInfo.sec: 1) and CaptionInfo.sec: http://.../sub.srt (when getCaptionInfo.sec: 1).
No redirects, no gzip. Answer TimeSeekRange.dlna.org with 406 unless time seek is offered (OP=1x).
- expected: The TV's DLNA reader opens with HEAD and aborts if it fails. Accepted statuses are only 100, 200-202 and 206-299; any 3xx, 4xx or 5xx fails the cast. It sends Range: bytes=N- for open and seek, and parses content-range including '*'. The sketch passed a loopback mock that replays these exact requests.

### Use TV MIME names in Content-Type and protocolInfo

- evidence: live-tv; needs live launch test: false
- request: mp4/m4v video/mp4; mov video/quicktime; mkv video/x-mkv (NOT video/x-matroska); webm video/webm; ts (188-byte) video/mpeg; m2ts/mts (192-byte) video/vnd.dlna.mpeg-tts; avi video/x-msvideo; wmv video/x-ms-wmv; flv video/x-flv; 3gp video/3gpp; mp3 audio/mpeg; m4a audio/mp4; aac (ADTS) audio/vnd.dlna.adts; flac audio/x-flac; wav audio/x-wav; ogg audio/ogg; wma audio/x-ms-wma; jpg image/jpeg; png image/png; bmp image/bmp; mpo image/mpo; srt text/srt (side-load); smi smi/caption.
- expected: Each name appears in the live Sink and in the TV DLNA reader's GetPlayableType list (that list also has image/gif and text/xml, which are not in the Sink). minidlna rewrites x-matroska to x-mkv for Samsung. Unlisted types (gif, webp, heic, mpegurl) may get 714 or not play; test them before offering.

### Cast a still image

- evidence: source-code; needs live launch test: true
- request: Same SetAVTransportURI, with this CurrentURIMetaData (shown unescaped; escape once more inside the envelope): <DIDL-Lite xmlns="urn:schemas-upnp-org:metadata-1-0/DIDL-Lite/" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:upnp="urn:schemas-upnp-org:metadata-1-0/upnp/" xmlns:dlna="urn:schemas-dlna-org:metadata-1-0/"><item id="0" parentID="-1" restricted="1"><dc:title>Lumen T2</dc:title><upnp:class>object.item.imageItem.photo</upnp:class><res protocolInfo="http-get:*:image/jpeg:DLNA.ORG_OP=01;DLNA.ORG_CI=0;DLNA.ORG_FLAGS=00F00000000000000000000000000000">http://192.168.1.7:PORT/m/t2/earthrise.jpg</res></item></DIDL-Lite>, then Play Speed 1. Variant T13: first X_PlayerAppHint <InstanceID>0</InstanceID><UpnpClass>object.item.imageItem</UpnpClass><PlayerHint>load</PlayerHint>.
- expected: The photo viewer shows the image. Transport reports PLAYING with RelTime 0:00:00 indefinitely, so do not treat that as a stall. The TV's reader requests transferMode Interactive for image types; the server must not answer 406. Next photo = another SetAVTransportURI (or SetNextAVTransportURI).

### Seek / pause / resume / stop

- evidence: source-code; needs live launch test: true
- request: #Seek: <InstanceID>0</InstanceID><Unit>REL_TIME</Unit><Target>0:00:05</Target> (format H:MM:SS; clamp the target to duration-1 s; retry 701 every 200 ms up to 8 tries). #Pause: <InstanceID>0</InstanceID>. #Play: <InstanceID>0</InstanceID><Speed>1</Speed>. #Stop: <InstanceID>0</InstanceID>.
- expected: 200, then TRANSITIONING then PLAYING at the new RelTime. With OP=01 the TV turns the seek into a new GET with Range: bytes=<offset>-. Faults: 711 Illegal seek target (target == length), 701 right after a seek or for Pause when already paused/stopped, 710 seek mode not supported. NavigateInPause suggests Seek is allowed while PAUSED_PLAYBACK. Use Speed=1 only.

### Cast a public internet URL (WebURIPlayable path)

- evidence: inferred; needs live launch test: true
- request: SetAVTransportURI with CurrentURI https://test-videos.co.uk/vids/bigbuckbunny/mp4/h264/720/Big_Buck_Bunny_720_10s_1MB.mp4 (200 video/mp4, Accept-Ranges, checked from the PC today) and DIDL protocolInfo http-get:*:video/mp4:DLNA.ORG_OP=01;DLNA.ORG_CI=0;DLNA.ORG_FLAGS=01700000000000000000000000000000, then Play. Before casting, Lumen should follow redirects itself and cast the final URL.
- expected: Most likely plays: mm-player hands plain http(s) URIs to souphttpsrc, which does TLS and follows redirects. The DLNA reader only parses 'http://' and fails on 3xx. If it fails with 716/704, proxy the URL through Lumen's media server.

### HLS (m3u8) cast

- evidence: decompiled; needs live launch test: true
- request: T10: CurrentURI https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8 with protocolInfo http-get:*:application/vnd.apple.mpegurl:* (class object.item.videoItem.movie). T10b: protocolInfo http-get:*:application/x-mpegURL:*. T10c: CurrentURIMetaData empty.
- expected: Unknown. mm-player switches to its HLS demuxer when the URI contains '.m3u8' or 'format=m3u8-aapl' (decompiled strings), but the DMR Sink lists no mpegurl type, so the DMR may answer 714 before playback. If every variant fails, remux HLS to MPEG-TS on the PC and serve it as video/mpeg.

### Subtitles (SRT side-load)

- evidence: decompiled; needs live launch test: true
- request: Add xmlns:sec="http://www.sec.co.kr/" to DIDL-Lite and <sec:CaptionInfoEx sec:type="srt">http://192.168.1.7:PORT/m/sub1/movie.srt</sec:CaptionInfoEx> inside <item>. Also answer the media GET/HEAD that carries 'getCaptionInfo.sec: 1' with header 'CaptionInfo.sec: http://192.168.1.7:PORT/m/sub1/movie.srt'. Serve the .srt as text/srt. Alternative during playback: RenderingControl X_ControlCaption(InstanceID 0, Operation Enable, Name, ResourceURI, CaptionURI, CaptionType srt, Language, Encoding UTF-8).
- expected: Subtitles shown in the DMR player. The TV DLNA reader sends getCaptionInfo.sec: 1 and parses CaptionInfo.sec (decompiled). minidlna notes newer series need CaptionInfoEx. Untested on 2020.

### Metadata strictness probes (decide the fallback ladder)

- evidence: inferred; needs live launch test: true
- request: T11b: same as T1 with protocolInfo http-get:*:video/mp4:* (no DLNA params). T11c: CurrentURIMetaData empty. T12: MKV labelled video/x-matroska.
- expected: T11b and T11c likely play, because the TV probes the stream itself. T12 will show whether the DMR validates MIME against the Sink (714) or ignores it. Results set Lumen's retry ladder: DLNA flags, then '*', then empty metadata.

### Diagnose why a cast stopped

- evidence: live-tv; needs live launch test: true
- request: #X_GetStoppedReason <InstanceID>0</InstanceID>; #GetMediaInfo; #GetTransportInfo (CurrentTransportStatus ERROR_OCCURRED).
- expected: Idle returns empty StoppedReason/StoppedReasonData. After a failed or finished cast the values are unknown; log them during the supervised tests to build a reason table.

### Orchestrator test runner (ranked cast list)

- evidence: inferred; needs live launch test: true
- request: PowerShell, user watching: $env:LUMEN_SUPERVISED='yes'; node C:/Users/pranj/AppData/Local/Temp/tvremote-re/dlna-cast/sketch/cast-test.mjs --supervised --case <ID> [--bind 192.168.1.7] [--seconds 25] [--no-stop] [--force].
Ranked: T1 local H.264 MP4; T2 local JPEG; T8 local MP4 + Seek 0:00:05/Pause/Play; T3 PNG test card; T4 MKV as video/x-mkv; T9 public HTTPS MP4; T11c empty metadata; T11b '*' protocolInfo; T5 WebM VP9; T6 HEVC MP4; T7 WAV; T12 x-matroska; T10/T10b/T10c HLS; T13 PlayerAppHint image; T14 long public 4K WebM + Seek 0:05:00.
'--list' prints cases; '--dry-run' prints the exact envelopes without contacting the TV.
- expected: Each run is under 40 s. It checks REST PowerState=on and that the DMR is idle (else aborts), logs every TV fetch of the PC server to live/cast-<ID>-*.jsonl (method, Range, UA, DLNA/Samsung headers), logs state at 1 Hz, and ends with X_GetStoppedReason + GetMediaInfo, then Stop. No User-Agent with gcf=1 means the dlnasrc path; a User-Agent means souphttpsrc. If no fetch arrives, check Windows Firewall for node.exe inbound on the LAN profile, or an on-TV access prompt.

### Fixes for the existing Lumen cast code

- evidence: inferred; needs live launch test: false
- request: server/features/cast.js:
- MIME_BY_EXT: mkv to video/x-mkv; flac to audio/x-flac; wav to audio/x-wav; aac to audio/vnd.dlna.adts; ts to video/mpeg; m2ts/mts to video/vnd.dlna.mpeg-tts. Gate gif/webp/m3u8 behind tests.
- classify(): cast res.url (the final URL after redirects); when HEAD fails, retry GET with Range: bytes=0-0.
- playDlna(): Stop when busy, then retry Play on 705/701.
- control('seek'): clamp to duration-1.
server/adapters/avtransport.js: protocolInfo for image/* should use FLAGS=00F00000...; formatTime may stay HH:MM:SS (H+ is valid) but H:MM:SS matches the TV and tv-remote.
serveFile: echo the request's transferMode; optionally add MediaInfo.sec.
- expected: Fewer 714/716 failures and working casts of redirected links. Unit-testable against sketch/mock-test.mjs.

## Code sketch

```js
// C:/Users/pranj/AppData/Local/Temp/tvremote-re/dlna-cast/sketch/dlna-cast.mjs (full file). Self-test: node mock-test.mjs
import http from 'node:http'; import fs from 'node:fs'; import fsp from 'node:fs/promises'; import path from 'node:path';

export const TV_MIME = { mp4:'video/mp4', m4v:'video/mp4', mov:'video/quicktime', mkv:'video/x-mkv', webm:'video/webm',
  ts:'video/mpeg', mpg:'video/mpeg', mpeg:'video/mpeg', m2ts:'video/vnd.dlna.mpeg-tts', mts:'video/vnd.dlna.mpeg-tts',
  avi:'video/x-msvideo', wmv:'video/x-ms-wmv', flv:'video/x-flv', '3gp':'video/3gpp', mp3:'audio/mpeg', m4a:'audio/mp4',
  aac:'audio/vnd.dlna.adts', flac:'audio/x-flac', wav:'audio/x-wav', ogg:'audio/ogg', wma:'audio/x-ms-wma',
  jpg:'image/jpeg', jpeg:'image/jpeg', png:'image/png', bmp:'image/bmp', mpo:'image/mpo', srt:'text/srt' };
export const mimeFor = (n) => TV_MIME[path.extname(n).slice(1).toLowerCase()] ?? null;
const flags = (b) => b.toString(16).toUpperCase().padStart(8, '0') + '0'.repeat(24); // TM_S 1<<24, TM_I 1<<23, TM_B 1<<22, STALL 1<<21, V1_5 1<<20
export const FEATURES_AV = `DLNA.ORG_OP=01;DLNA.ORG_CI=0;DLNA.ORG_FLAGS=${flags(0x01700000)}`;
export const FEATURES_IMAGE = `DLNA.ORG_OP=01;DLNA.ORG_CI=0;DLNA.ORG_FLAGS=${flags(0x00f00000)}`;
export const featuresFor = (m) => (m.startsWith('image/') ? FEATURES_IMAGE : FEATURES_AV);
const ESC = { '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&apos;' };
export const xmlEscape = (s) => String(s).replace(/[&<>"']/g, (c) => ESC[c]);
export const hms = (s) => { const t = Math.max(0, Math.floor(s)); return `${Math.floor(t/3600)}:${String(Math.floor(t/60)%60).padStart(2,'0')}:${String(t%60).padStart(2,'0')}`; };
export const upnpClass = (m) => m.startsWith('image/') ? 'object.item.imageItem.photo' : m.startsWith('audio/') ? 'object.item.audioItem.musicTrack' : 'object.item.videoItem.movie';

export function buildDidl({ uri, title, mime, protocolInfo, durationSec, subtitleUrl }) {
  const pi = protocolInfo ?? `http-get:*:${mime}:${featuresFor(mime)}`;
  const dur = durationSec ? ` duration="${hms(durationSec)}.000"` : '';
  const sec = subtitleUrl ? `<sec:CaptionInfoEx sec:type="srt">${xmlEscape(subtitleUrl)}</sec:CaptionInfoEx>` : '';
  return '<DIDL-Lite xmlns="urn:schemas-upnp-org:metadata-1-0/DIDL-Lite/" xmlns:dc="http://purl.org/dc/elements/1.1/"'
    + ' xmlns:upnp="urn:schemas-upnp-org:metadata-1-0/upnp/" xmlns:dlna="urn:schemas-dlna-org:metadata-1-0/"'
    + (subtitleUrl ? ' xmlns:sec="http://www.sec.co.kr/"' : '') + '><item id="0" parentID="-1" restricted="1">'
    + `<dc:title>${xmlEscape(title)}</dc:title><upnp:class>${upnpClass(mime)}</upnp:class>`
    + `<res protocolInfo="${xmlEscape(pi)}"${dur}>${xmlEscape(uri)}</res>${sec}</item></DIDL-Lite>`;
}
export const envelope = (svc, action, args) => '<?xml version="1.0" encoding="utf-8"?><s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"'
  + ` s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/"><s:Body><u:${action} xmlns:u="urn:schemas-upnp-org:service:${svc}:1">`
  + args.map(([k, v]) => `<${k}>${xmlEscape(v)}</${k}>`).join('') + `</u:${action}></s:Body></s:Envelope>`; // DIDL is escaped a 2nd time here

export function createDmr({ host = '192.168.1.2', port = 9197 } = {}) {
  const P = { AVTransport: '/upnp/control/AVTransport1', ConnectionManager: '/upnp/control/ConnectionManager1' };
  async function call(svc, action, args = []) {
    const res = await fetch(`http://${host}:${port}${P[svc]}`, { method: 'POST', signal: AbortSignal.timeout(6000),
      headers: { 'Content-Type': 'text/xml; charset="utf-8"', SOAPACTION: `"urn:schemas-upnp-org:service:${svc}:1#${action}"` },
      body: envelope(svc, action, args) });
    const text = await res.text();
    if (!res.ok) throw Object.assign(new Error(`${action} fault`), { action, code: Number(/<errorCode>\s*(\d+)/.exec(text)?.[1]) || null, desc: /<errorDescription>([^<]*)/.exec(text)?.[1] });
    const out = {}, inner = new RegExp(`<u:${action}Response[^>]*>([\\s\\S]*?)</u:${action}Response>`).exec(text)?.[1] ?? '';
    for (const m of inner.matchAll(/<(\w+)>([\s\S]*?)<\/\1>/g)) out[m[1]] = m[2].replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&quot;/g,'"').replace(/&apos;/g,"'").replace(/&amp;/g,'&').trim();
    return out;
  }
  const avt = (a, args = []) => call('AVTransport', a, [['InstanceID', 0], ...args]);
  return { call, getProtocolInfo: () => call('ConnectionManager', 'GetProtocolInfo'),
    getTransportInfo: () => avt('GetTransportInfo'), getPositionInfo: () => avt('GetPositionInfo'), getMediaInfo: () => avt('GetMediaInfo'),
    getStoppedReason: () => avt('X_GetStoppedReason'),
    setUri: (uri, didl = '') => avt('SetAVTransportURI', [['CurrentURI', uri], ['CurrentURIMetaData', didl]]),
    playerAppHint: (cls, hint = 'load') => avt('X_PlayerAppHint', [['UpnpClass', cls], ['PlayerHint', hint]]),
    play: (speed = '1') => avt('Play', [['Speed', speed]]), pause: () => avt('Pause'), stop: () => avt('Stop'),
    seek: (sec) => avt('Seek', [['Unit', 'REL_TIME'], ['Target', hms(sec)]]) };
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const transient = (e) => e.code === 701 || e.code === 705;
export async function cast(dmr, o) { // Stop-if-busy -> SetAVTransportURI -> Play (retry 705/701)
  const t = await dmr.getTransportInfo();
  if (['PLAYING', 'PAUSED_PLAYBACK', 'TRANSITIONING'].includes(t.CurrentTransportState)) await dmr.stop().catch(() => {});
  await dmr.setUri(o.uri, o.emptyMetadata ? '' : buildDidl(o));
  for (let i = 0; ; i++) { try { return await dmr.play('1'); } catch (e) { if (!transient(e) || i >= 20) throw e; await sleep(500); } }
}
export async function seekSafe(dmr, sec, dur) { // 711 at exact end; 701 ~0.2 s after a seek
  const target = dur ? Math.min(sec, Math.max(0, dur - 1)) : sec;
  for (let i = 0; ; i++) { try { return await dmr.seek(target); } catch (e) { if (!transient(e) || i >= 7) throw e; await sleep(200); } }
}

// Media server: HEAD must be 2xx (TV aborts otherwise), single Range 206/416, DLNA + Samsung headers, never redirect.
export function createMediaServer({ bindHost, port = 0, log = console.log } = {}) {
  const files = new Map();
  const server = http.createServer((req, res) => {
    const h = req.headers, u = new URL(req.url, 'http://x'), e = u.pathname.startsWith('/m/') ? files.get(u.pathname.split('/')[2]) : null;
    log(JSON.stringify({ method: req.method, path: u.pathname, http: req.httpVersion, range: h.range, ua: h['user-agent'],
      tm: h['transfermode.dlna.org'], gcf: h['getcontentfeatures.dlna.org'], cap: h['getcaptioninfo.sec'], mi: h['getmediainfo.sec'], tsr: h['timeseekrange.dlna.org'] }));
    if (!e) return res.writeHead(404, { 'Content-Length': 0 }).end();
    if (req.method !== 'GET' && req.method !== 'HEAD') return res.writeHead(405, { Allow: 'GET, HEAD', 'Content-Length': 0 }).end();
    const tm = h['transfermode.dlna.org'] ?? '';
    const hdr = { 'Content-Type': e.mime, 'Accept-Ranges': 'bytes', 'contentFeatures.dlna.org': featuresFor(e.mime), 'Cache-Control': 'no-cache',
      'transferMode.dlna.org': /^(Streaming|Interactive|Background)$/i.test(tm) ? tm : (e.mime.startsWith('image/') ? 'Interactive' : 'Streaming') };
    if (e.durationSec && h['getmediainfo.sec'] === '1') hdr['MediaInfo.sec'] = `SEC_Duration=${Math.round(e.durationSec * 1000)};`;
    if (e.subtitleUrl && h['getcaptioninfo.sec'] === '1') hdr['CaptionInfo.sec'] = e.subtitleUrl;
    if (h['timeseekrange.dlna.org']) return res.writeHead(406, { ...hdr, 'Content-Length': 0 }).end();
    let start = 0, end = e.size - 1, status = 200;
    const m = /^bytes=(\d*)-(\d*)/.exec(h.range ?? '');
    if (m && (m[1] || m[2])) {
      if (m[1] === '') start = Math.max(0, e.size - Number(m[2])); else { start = Number(m[1]); if (m[2]) end = Math.min(Number(m[2]), e.size - 1); }
      if (start >= e.size || start > end) return res.writeHead(416, { ...hdr, 'Content-Range': `bytes */${e.size}`, 'Content-Length': 0 }).end();
      status = 206; hdr['Content-Range'] = `bytes ${start}-${end}/${e.size}`;
    }
    hdr['Content-Length'] = end - start + 1;
    res.writeHead(status, hdr);
    if (req.method === 'HEAD') return res.end();
    const rs = fs.createReadStream(e.file, { start, end, highWaterMark: 1 << 20 }); rs.pipe(res); res.on('close', () => rs.destroy());
  });
  return { server, listen: () => new Promise((r) => server.listen(port, bindHost, () => r(server.address()))),
    async add(id, file, { mime = mimeFor(file), durationSec, subtitleUrl } = {}) {
      const { size } = await fsp.stat(file); files.set(id, { file, mime, size, durationSec, subtitleUrl });
      const a = server.address(); return { url: `http://${a.address}:${a.port}/m/${id}/${encodeURIComponent(path.basename(file))}`, mime, size };
    }, close: () => new Promise((r) => server.close(r)) };
}
// Usage: const ms = createMediaServer({ bindHost: '192.168.1.7' }); await ms.listen();
// const { url, mime } = await ms.add('t1', 'C:/.../clip.mp4', { durationSec: 10 });
// const dmr = createDmr(); await cast(dmr, { uri: url, title: 'Clip', mime }); then poll getTransportInfo/getPositionInfo at 1 Hz.
```

## Open questions

- Which player path does the 2020 DMR (vd_dmr, absent from the emulator image) use for a pushed URI: 'dlna://' (DLNA reader: strict HEAD, no redirects, http only) or plain http(s) via souphttpsrc? The fetch log from T1 and T9 answers it: no User-Agent plus getcontentFeatures.dlna.org means dlnasrc.
- Does the DMR check the protocolInfo MIME against its Sink list (714 for video/x-matroska or *mpegurl), or ignore it? T12 and T10/T10b answer it. Is empty CurrentURIMetaData accepted (T11c)?
- HLS: can m3u8 be cast at all through the DMR (T10/T10b/T10c)? If not, Lumen must remux to MPEG-TS (video/mpeg) or open the TV browser instead.
- Does the TV show an on-screen 'Allow device' / access prompt the first time the PC sends SetAVTransportURI (Device Connection Manager)? Is the existing 'Lumen Remote' pairing enough? Watch the TV during T1.
- Exact meaning of WebURIPlayable and NavigateInPause on this firmware. Only the token-to-ability-flag mapping in Samsung's own control point (libasfmediasharecp) is known; the semantics above are inferred.
- Does SetAVTransportURI fail while another cast is PLAYING (is the Stop-first step needed)? Does SetNextAVTransportURI advance automatically (gapless)? Does the DMR honour sec:CaptionInfoEx, the CaptionInfo.sec header or X_ControlCaption on the 2020 firmware?
- Units of MediaInfo.sec SEC_Duration: the decompile shows the 'SEC_Duration=<int>;' format parsed by strtoll; milliseconds is assumed from minidlna/Serviio practice. Does providing it improve the progress bar or seeking for unknown-length streams?
- StoppedReason / StoppedReasonData values after a failed or finished cast (X_GetStoppedReason was empty while idle). Log them in every supervised run.
- Does the DMR push AVTransport LastChange events during a cast (TransportState transitions) reliably enough to drop the 1 Hz GetTransportInfo poll? GetPositionInfo polling stays necessary either way.
- Windows Firewall: the TV must reach node.exe on an ephemeral LAN port. GENA NOTIFY reached node.exe earlier today, but if T1 shows no tv-fetch lines, check the inbound rule before blaming the TV.

## Live results (2026-10-21 ~21:30 IST, orchestrator, cast-test.mjs)

- **T2 JPEG from the PC: works.** SetAVTransportURI → cast-ok in 0.7 s; the TV fetched HEAD, then GET `Range: bytes=0-` with `transferMode.dlna.org: Interactive`, `getcontentFeatures.dlna.org: 1`, `Connection: close`; state TRANSITIONING ×2 then PLAYING (pos 0, as expected for images).
- **T1 local H.264 MP4 (video-only test clip): rejected.** The TV fetched HEAD, GET `bytes=0-` (`transferMode: Streaming`, `getMediaInfo.sec: 1`), then GET `bytes=146869-`, and stopped with `X_GetStoppedReason = STOPPED_ERROR / ERR_NOT_SUPPORTED_FORMAT`. **T9 (same clip over public HTTPS, TV fetches itself): same error.** So the SOAP/serving path is right; the clip itself (video-only, from test-videos.co.uk) is what the DMR rejects. Test with a normal H.264+AAC MP4.
- Fetch pattern confirmed from the decompile: HEAD then GET, HTTP/1.1, no User-Agent, `Connection: close`.
- **Real H.264+AAC MP4 from the PC (a 6 s game capture) plays:** cast-ok 0.47 s, TRANSITIONING ×2, PLAYING with RelTime advancing 0.745 → 5.866 s (TrackDuration 6), then STOPPED with `STOPPED_FINISHED`. Six TV fetches (HEAD/GET pattern as above). Video casting is verified; the earlier failures were the video-only test clips.
