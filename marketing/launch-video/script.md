# Drive — launch video script

On-screen script for the 75-second launch video (`index.html`). No spoken
narration. The video ships **silent**: no music track is used, so there is no
music licence to clear (drive#651).

| Time | On screen | Source for the claim |
| --- | --- | --- |
| 0:00–0:06 | For people and their agents · **A drive that holds more than your laptop.** · Plain files in object storage, opened by the apps you already use. | `README.md` first paragraph; `public/index.html` hero line "A Finder drive for people and their agents". |
| 0:06–0:17 | **Real files in a real Finder folder.** · Drag in, double-click, scrub the timeline. | `public/index.html`, section "It is just a drive in Finder". |
| 0:17–0:29 | **Huge files. Tiny disk.** · A 5 GB video starts without a 5 GB download. | `README.md` ("a 5 GB video starts without a 5 GB download"); `public/index.html` section "Huge files. Tiny disk." |
| 0:29–0:41 | **One command. Every agent.** · Agent keys can list, read and write. **They can never delete.** | `public/index.html` section "One command. Every agent." and "Agent keys can list, read and write. They can never delete." |
| 0:41–0:53 | **One price: 2¢ per GB.** · Never more than $10 per TB. No plans. Balance never expires. | `README.md` ("One price") and `src/billing.js` (the one billing function that pins the rate). |
| 0:53–1:04 | **A cap that stops writes, not files.** · At the cap, writes stop. Every file stays. | `public/index.html` section "A cap that stops writes, not files." |
| 1:04–1:15 | **Get drive.** · The drive is not open yet. Sign-ups go to the waitlist. · Join the waitlist · drive-pricing.nishant345.workers.dev | `README.md` ("The drive is not open yet. Sign-ups on the pricing page go to a waitlist.") |

## Visuals

Every frame is a screenshot of the product's own pages, captured locally from
`public/` and `get-started.html` (the live site is behind Cloudflare Access, so
the capture is served from a local static copy of the same files). No stock
footage, no invented UI, no rival brand marks.

- `assets/home_hero.png` — pricing hero
- `assets/home_finder.png` — "Huge files. Tiny disk."
- `assets/home_agents.png` — "One command. Every agent."
- `assets/home_calculator.png` — price slider
- `assets/home_cap.png` — spend cap
- `assets/getstarted2.png` — get-started / waitlist

## Music

None. The video is silent. A commercial-licence track was not available to the
builder, so per drive#651 the video ships without music rather than with an
uncleared track.

## Rebuild

```sh
cd marketing/launch-video
npx --yes hyperframes@0.8.134 check
npx --yes hyperframes@0.8.134 render --resolution landscape --format mp4 -o /tmp/drive-launch-video.mp4
```
