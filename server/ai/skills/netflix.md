---
app: Netflix
slug: netflix
appIds: 3201907018807, org.tizen.netflix-app
summary: Titles play directly with open_netflix (TV agent deep link). Search has its own keyboard.
updated: 2026-10-23
verified: 2026-10-23 (Friends played via open_netflix; search for The Office by sight)
---
# Netflix

- Playing a title: use open_netflix with the title id (the number in netflix.com/title/<id>); with the TV agent connected it starts playing, even from a cold start. play_title does this for you.
- Cold start without a deep link shows the profile picker.
- Search: from Home, the menu is on the left; its first item is the magnifier (Search). The search page has its own keyboard (type_text does not reach it): a row with space and delete, then six columns a–f, g–l, m–r, s–x, y z 1 2 3 4, 5–0. Results appear to the right.
- In the player, Back returns to the title page.
