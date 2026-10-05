# Drive launch video — script

Silent, 75 seconds, 1920x1080, 30 fps. All copy is on screen. There is no voice-over.

## Timeline

| time (s) | scene | on-screen text | source screen |
| --- | --- | --- | --- |
| 0–6 | intro | FOR PEOPLE AND THEIR AGENTS · "A drive that holds more than your laptop." · "Plain files in object storage, opened by the apps you already use." | — |
| 6–17 | hero | THE DRIVE · "Plain files, opened by the apps you already use." | `public/index.html` hero |
| 17–28 | huge files | HUGE FILES · "A 5 GB video starts without a 5 GB download." | `public/index.html` finder section |
| 28–40 | agents | EVERY AGENT · "Agent keys can list, read and write. They can never delete." | `public/index.html` agents section |
| 40–52 | price | ONE PRICE · "2¢ per GB. Never more than $10 per TB." | `public/index.html` calculator |
| 52–64 | cap | THE CAP · "At the cap, writes stop. Every file stays." | `public/index.html` cap section |
| 64–75 | cta | drive · "Get drive." · "The drive is not open yet. Sign-ups go to the waitlist." · `drive-pricing.nishant345.workers.dev` | — |

## Claims and their sources

| on-screen claim | source |
| --- | --- |
| "A drive that holds more than your laptop." | `public/index.html` hero headline |
| "Plain files in object storage, opened by the apps you already use." | `public/index.html` hero subhead |
| "A 5 GB video starts without a 5 GB download." | `public/index.html` finder section ("A 5 GB video starts without a 5 GB download.") — measured on the page |
| "Agent keys can list, read and write. They can never delete." | `public/index.html` agents section; `README.md` ("an agent key can list, read and write, but it can never delete") |
| "2¢ per GB. Never more than $10 per TB." | `public/index.html` calculator; `README.md` pricing line |
| "At the cap, writes stop. Every file stays." | `public/index.html` cap section ("A cap that stops writes, not files.") |
| "The drive is not open yet. Sign-ups go to the waitlist." | `public/index.html` waitlist copy |
| `drive-pricing.nishant345.workers.dev` | the live site host (README / `wrangler.jsonc` route) |

## Music

No music. The video ships silent, so there is no track licence to clear.

## Screens

The five product frames are real screenshots of the Drive web pages, captured from
`public/index.html` served locally (the production site is behind Cloudflare
Access). Captures are 1920x1080 with the page ticker hidden so no frozen
animation appears in the stills.
