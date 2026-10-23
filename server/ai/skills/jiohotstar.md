---
app: JioHotstar
slug: jiohotstar
appIds: fiZNCxMH9Y.Hotstar
summary: Open, search on its own A–Z keyboard, open the top result, Watch Now. Verified live on the Q95T.
updated: 2026-10-23
verified: 2026-10-23 (Harold & Kumar Escape from Guantanamo Bay played)
---
# JioHotstar

- Cold start shows "Who's watching?" with the last-used profile highlighted; OK picks it.
- Home: focus starts on the featured banner. Left opens the side menu with Home selected; Search is the item above Home.
- Search has its own keyboard (type_text does not reach it): a 7-column A–Z grid, then Space and 123; focus starts on A. Results update as you type; the "top result" card sits to the right of the keyboard.
- A title page focuses its main button (Watch Now / Watch Next / Resume); OK plays.
- Deep links: the app declares search.format {"assetId":"%%CONTENT_ID%%"} (the JustWatch id at the end of hotstar.com URLs), but PAYLOAD with that JSON, with or without {"values": …}, only opened Home in tests. Use the search flow.
- From a page other than Home (a title page or the player), press Back until Home before the search flow.

## Flows

```json
{
  "open": [
    { "launch": true },
    { "wait": 5000 },
    { "ifColdStart": [ { "keys": ["KEY_ENTER"] }, { "wait": 4000 } ] }
  ],
  "search": [
    { "keys": ["KEY_LEFT"] },
    { "wait": 800 },
    { "keys": ["KEY_UP", "KEY_ENTER"] },
    { "wait": 1800 }
  ],
  "type": [
    { "typeGrid": { "rows": [["A","B","C","D","E","F","G"],["H","I","J","K","L","M","N"],["O","P","Q","R","S","T","U"],["V","W","X","Y","Z",null,"Delete"],["Space","Space","Space","Space","Space","123","123"]], "start": "A", "maxChars": 16 } },
    { "wait": 2500 }
  ],
  "pickResult": [
    { "exitGrid": "right" },
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
