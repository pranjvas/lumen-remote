---
app: Developer mode
slug: developer-mode
scope: tv
runWith: enable_developer_mode
appIds: org.volt.apps, com.samsung.tv.coba.apps
summary: Turn on the TV's Developer mode with this PC as Host PC IP, blind (no TV agent, no Lumen Eyes): Apps, 1 2 3 4 5, On, this PC's address, OK. Then the owner restarts the TV.
updated: 2026-10-24
---
# Developer mode (TV skill)

Developer mode lets one PC (the Host PC IP) install and debug apps on the TV. Lumen needs it for the TV agent (lumenrmt01.LumenAgent) and Lumen Eyes, so this skill can use neither: it is a fixed key sequence over the remote channel, checked only with what the TV reports itself. Run it with enable_developer_mode, never key by key.

## The path (same on every Tizen TV, 2016 onwards)

- Open Apps. Lumen asks the TV to open it over REST, trying these ids in order: org.volt.apps (the Apps panel on 2016–2021 Smart Hub; package com.samsung.tv.store), then com.samsung.tv.coba.apps (the newer UI). A TV that does not have an id refuses it (404), which changes nothing. If neither opens, the owner opens Apps (Home, then Apps) and Lumen continues.
- Enter 1 2 3 4 5 with the number keys. Lumen sends KEY_1…KEY_5 over the network, so a remote without number keys does not matter (people with those remotes use the 123 button's on-screen pad; some report that only a phone remote such as SmartThings worked, which sends the same codes as Lumen).
- The Developer mode box appears: "Developer mode: Off" with [On] [Off] (On on the left, focused when the box opens), "Host PC IP" as four number boxes, and [OK] [Cancel] below.
- Select On, type this PC's address into the four boxes with the number keys, select OK.
- An Information notice follows: "Develop Mode is in On status. To enable developer mode on a TV, turn it off and then restart it. You can turn the TV off by holding the power button for 2 seconds." Close it.
- Restart the TV. Lumen cannot do this part: holding Power is a long press Lumen never sends, and a short press only puts the TV in standby. The owner holds Power on the TV remote for about 2 seconds until the TV turns off, then turns it on (if that is not enough, unplug for 10 seconds). Afterwards Apps shows "DEVELOP MODE" at the top, and REST reports developerMode 1 with this PC as host.

## By year

- 2016–2023 (Tizen 2.4–7.0): type 1 2 3 4 5 on the Apps panel itself. Samsung's TV Device guide said exactly this from 2017 until at least mid-2024, with figures of the 2016–2017 and 2018–2020 Smart Hub.
- 2024 and later (Tizen 8+, the For You / Live / Apps home): the code goes into Apps → App Settings (the Settings row at the bottom of Apps). Lumen cannot reach App Settings without seeing the screen, so the owner opens it and Lumen continues from the code.
- The box itself is the same in every version Samsung published: On/Off, four Host PC IP boxes, OK/Cancel.
- Arabic and Hebrew menus show the IP boxes right to left; Lumen types the address reversed for those languages (from Moonlight-Tizen's guide; not seen by Lumen yet).

## Blind-flow cautions

- Lumen cannot see whether the box appeared. After 1 2 3 4 5 it stops and the owner says whether the box is on screen (or the AI looks, when Lumen Eyes happens to be running). Only then does Lumen move inside the box, so stray presses never land on the Apps screen or the TV menus.
- Inside the box every move starts from a fixed corner: Up, Up reaches the On/Off row from anywhere; Down from there reaches the IP boxes; Left three times reaches the first box. Each IP part is typed after returning to the first box and pressing Right to its box, so it works whether or not a box jumps to the next one after three digits.
- The TV keyboard must stay closed (remote channel ms.remote.imeStart / imeEnd). If it opens, the keys went into a text field: Lumen presses Back and stops without saving.
- OK is reached by Up, Up, Down, Down, Left (bottom row, left button). The notice after OK is closed with Back, never OK, in case it does not appear.
- Back (KEY_RETURN) closes the box without saving. That is the safe way out at any point.
- No power keys: the owner restarts the TV.

## Flows

```json
{
  "open": [
    { "launch": true, "note": "Apps (org.volt.apps, then com.samsung.tv.coba.apps)" },
    { "wait": 4000 }
  ],
  "code": [
    { "waitIme": { "open": false }, "note": "no TV keyboard open, so the digits cannot go into a text field" },
    { "keys": ["KEY_1", "KEY_2", "KEY_3", "KEY_4", "KEY_5"], "gapMs": 300 },
    { "wait": 2500 },
    { "waitIme": { "open": false }, "note": "still no keyboard: the digits reached the Apps screen" }
  ],
  "switchOn": [
    { "keys": ["KEY_UP", "KEY_UP", "KEY_LEFT"], "gapMs": 300, "note": "the On button (top row, left) from wherever the focus is" },
    { "keys": ["KEY_ENTER"] },
    { "wait": 800 }
  ],
  "hostIp": [
    { "typeDigits": { "var": "pcAddress", "split": ".", "home": ["KEY_UP", "KEY_UP", "KEY_DOWN", "KEY_LEFT", "KEY_LEFT", "KEY_LEFT"], "next": "KEY_RIGHT" }, "gapMs": 300, "note": "each part: back to the first box, Right to its box, its digits" },
    { "wait": 600 },
    { "waitIme": { "open": false }, "note": "the number boxes took the digits without opening a keyboard" }
  ],
  "hostIpKeyboard": [
    { "keys": ["KEY_UP", "KEY_UP", "KEY_DOWN", "KEY_LEFT", "KEY_LEFT", "KEY_LEFT"], "gapMs": 300, "note": "only for a TV whose Host PC IP opens the TV keyboard" },
    { "keys": ["KEY_ENTER"] },
    { "waitIme": { "open": true, "timeoutMs": 4000 } },
    { "typeText": { "var": "pcAddress", "submit": true } },
    { "waitIme": { "open": false, "timeoutMs": 4000 } }
  ],
  "confirm": [
    { "keys": ["KEY_UP", "KEY_UP", "KEY_DOWN", "KEY_DOWN", "KEY_LEFT"], "gapMs": 300, "note": "OK (bottom row, left)" },
    { "keys": ["KEY_ENTER"] },
    { "wait": 2500 },
    { "keys": ["KEY_RETURN"], "note": "closes the restart notice" },
    { "wait": 800 }
  ],
  "cancel": [
    { "ifIme": [{ "keys": ["KEY_RETURN"] }, { "wait": 700 }] },
    { "keys": ["KEY_RETURN"], "note": "Back closes the box without saving" },
    { "wait": 800 }
  ]
}
```
