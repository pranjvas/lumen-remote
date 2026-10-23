# Can the Lumen Agent see the screen? (on-TV capture / accessibility)

Salvaged 2026-10-23 from the eyes:on-tv workflow agent (its structured report failed schema validation). Verdict: unlikely. Evidence is static/decompiled from the Tizen 5.5 TV emulator image, not yet confirmed on the Q95T.

At public-certificate level the Lumen Agent cannot see the screen. Screenshot/pixel capture is platform-level on this TV, so no public app (web or native) can use it. The web app sees only its own DOM. The only candidate for app-wide read-focused-text is eavesdropping the AT-SPI accessibility bus, which needs a native/.NET rebuild (web JS has no D-Bus), is unverified on real firmware SMACK, and depends on apps exposing a11y trees (Netflix likely does not). Evidence is decompiled/static from the Tizen 5.5 TV SDK image, not confirmed on the live Q95T.


**recipe:** Evidence decompiled from Tizen 5.5 TV image surfaces/img/r0; copy at eyes/on-tv/FINDINGS.md. (1) privilege.db PRIVILEGE_INFO: privilege/screenshot = core, level platform; NO wrt row so a web app can never declare it; MAPPING internal/appdebugging to screenshot is the sdb debugger, not an app API. (2) usr/bin/enlightenment enforces it: strings privilege/screenshot then Privilege Check Failed DENY screenshot pid, e_security_privilege_check, src/bin/e_comp_wl_screenshooter.c gating tizen_screenshooter/tizen_screenmirror. (3) usr/lib/libcapi-ui-efl-util.so efl_util_take_screenshot gives screenshot fail privilege error - the efl/ecore route, platform-only. (4) usr/lib/tizen-extensions-crosswalk has NO capture/tts/accessibility plugin, only tvaudio/tvchannel/tvdisplay/tvinfo/tvinputdevice/tvwindow/voicecontrol/systeminfo etc; webapis.js exposes only microphone/tvinfo/productinfo/displayrotator/avplay* - no capture/avinfo. So web agent = zero pixels, own DOM only. (5) no Tizen.Multimedia still-capture; only ScreenMirroring Miracast sink. (6) AT-SPI2 present (libatspi.so.0, at-spi-bus-launcher, at-spi2-registryd, org.a11y.Bus); accessibility.conf = auth EXTERNAL, policy owner allow eavesdrop and own all, NO cynara gate, no a11y privilege. So a native process on org.a11y.Bus could eavesdrop focus/announcement = read focused text of apps exposing trees. Caveats: web JS has no D-Bus (needs native/.NET or pure-JS dbus in Node service via org.a11y.Bus.GetAddress); real firmware SMACK may refuse a public label on the /tmp a11y socket; Netflix/custom renderers expose little tree. (7) Voice Guide = screen reader: app tree to at-spi2-registryd to elementary access_output_tts (tts_play) to libtts/org.tizen.tts-engine-vd. To read spoken text you must be the platform TTS engine or eavesdrop a11y bus. Public tizen.tts/libtts only speaks text you give. Web tizen.voicecontrol (libtizen_voicecontrol.so, privilege recorder=public) returns only the USERs recognized command, not screen text. Recommendation: no on-TV pixels at public level (needs partner/platform cert). Best public-ish sight = AT-SPI focused-text in a native/.NET agent (subscribe object:state-changed:focused + text-changed/announcement, read name/role/text), treat as partner-grade until a supervised probe confirms it. Meanwhile use proven reads: tvchannel/hybridchannelinfo (programme), getAppsInfo/getAppsContext (foreground app), tvwindow.getSource (input).


**latency_quality:** Pixel capture not applicable at public level. AT-SPI focused-text (if viable via native agent): event-driven push in tens of ms, like the GENA volume events, no polling. Text-only and sparse: focused element name/role/value, not a full screen description, only for apps that populate the tree (good in Samsung EFL/DALi UI; weak/absent in Netflix/Prime/YouTube). Web own-DOM canvas snapshot is instant but covers only Lumens own page.


**user_actions:** Keep developer mode and the signed agent installed.


**user_actions:** For an AT-SPI prototype, rebuild the agent as native (libatspi) or .NET; web JS has no D-Bus.


**user_actions:** For pixel capture, obtain a Samsung partner/platform certificate; public cert can never grant privilege/screenshot.


**user_actions:** Enable Voice Guide in Settings > General > Accessibility so a supervised a11y probe has signals.


**user_actions:** Defer all on-TV probing until the TV is on and you are present.


**live_tests:** Get the a11y bus address via org.a11y.Bus.GetAddress, connect with EXTERNAL auth, eavesdrop org.a11y.atspi events to confirm a non-platform process may connect (tests real-firmware SMACK).


**live_tests:** With Voice Guide on, move focus in Settings/Smart Hub and record object:state-changed:focused + announcement name/role/text.


**live_tests:** Repeat focus moves in Netflix, Prime, YouTube to measure how much AT-SPI tree each exposes.


**live_tests:** From the web agent, re-confirm at runtime no capture/screenshot API appears on webapis/tizen.


**live_tests:** Register a tizen.voicecontrol command list and read addResultListener payloads to confirm it returns only user-spoken commands.


**risks:** Evidence is from the Dec-2019 x86 emulator image, not the TVs 2026 armv7 build; the a11y bus SMACK policy on real firmware may differ from the open accessibility.conf (biggest unknown).


**risks:** The AT-SPI eavesdrop path may be refused by SMACK for a public app, removing the only on-TV sight option.


**risks:** Third-party streaming apps may expose no accessibility tree, so coverage could be near-zero where most wanted.


**risks:** A native/.NET rebuild for D-Bus loses the web stacks convenience and still cannot capture pixels; real pixels need a partner/platform cert.


**risks:** Do not confuse tizen.voicecontrol (user ASR) or libtts (output only) with screen reading.


**risks:** Fallback if on-TV sight fails: use REST visible + getAppsContext (foreground), tvchannel/hybridchannelinfo (programme), tvwindow.getSource / IP Control getTVStates.inputSource (input), and drive apps semi-blind via deep-links and key macros.

