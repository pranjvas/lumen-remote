---
app: Apple TV
slug: apple-tv
appIds: 3201807016597, com.samsung.tv.aria-video
summary: Menu → Search, type on its own a–z keyboard, open the top result, Play Episode. Verified live on the Q95T.
updated: 2026-10-23
verified: 2026-10-23 (Severance found by search and played; Apple TV+ is active)
---
# Apple TV

- Apple TV+ is active on this account: "Play Episode" (or "Play") plays. "Connect Subscription" next to it is for other channels; ignore it.
- The app reopens where it was left (often a show page). Up repeatedly opens the side menu on the left and moves to its top (the profile, "Switch Profile" — never press OK there); Down once from the top is Search. Menu: Search, Home, Apple TV, MLS, Store, Library, Settings.
- Search has its own keyboard (type_text does not reach it): six columns a–f, g–l, m–r, s–x, then y z, then SPACE, delete and CLEAR; focus starts on "a". Results show as you type.
- Moving Right off the keyboard lands on the suggestion chip under the query; two Downs reach the first result card (the top-left one).
- A title that is not on Apple TV shows '"<title>" is not available. You might also like:' — stop and say so (use find_title for where it streams).
- A show page focuses "Play Episode" (the next or resumed episode). A specific season or episode is in the rows below the buttons; that path is not learned yet.
- In the player, Back returns to the show page.

## Flows

```json
{
  "open": [
    { "launch": true },
    { "wait": 6000 }
  ],
  "search": [
    { "keys": ["KEY_UP", "KEY_UP", "KEY_UP", "KEY_UP", "KEY_UP", "KEY_UP", "KEY_UP", "KEY_UP"], "gapMs": 250 },
    { "wait": 700 },
    { "keys": ["KEY_DOWN", "KEY_ENTER"] },
    { "wait": 2000 }
  ],
  "type": [
    { "typeGrid": { "rows": [["a","b","c","d","e","f"],["g","h","i","j","k","l"],["m","n","o","p","q","r"],["s","t","u","v","w","x"],["y","z",null,null,null,null],["Space","Space","Delete","Delete","Clear","Clear"]], "start": "a", "maxChars": 20 } },
    { "wait": 2500 }
  ],
  "pickResult": [
    { "exitGrid": "right" },
    { "wait": 600 },
    { "keys": ["KEY_DOWN", "KEY_DOWN"] },
    { "wait": 500 },
    { "keys": ["KEY_ENTER"] },
    { "wait": 3500 }
  ],
  "play": [
    { "keys": ["KEY_ENTER"] },
    { "wait": 6000 },
    { "look": true }
  ]
}
```
