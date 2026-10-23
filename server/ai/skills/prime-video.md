---
app: Prime Video
slug: prime-video
appIds: 3201910019365, org.tizen.primevideo
summary: Opens with launch_app; many titles are rent/buy only (costs money) — never rent or buy.
updated: 2026-10-23
---
# Prime Video

- Many titles in India are "rent" or "buy" on Prime Video (JustWatch "Amazon Video"); renting or buying costs money. Never press Rent, Buy or any price button; tell the user instead.
- DIAL (AmazonInstantVideo) refused title links with HTTP 403, so open_prime cannot deep link; open the app and use its search.
- The search flow is not learned yet: after finding it by sight, save it with save_app_skill.
