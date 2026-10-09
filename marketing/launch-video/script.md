# Storagebun launch video — script

Silent, 75 seconds, 1920x1080, 30 fps. All copy is on screen. There is no voice-over.

## Timeline

| time (s) | scene | on-screen text | source screen |
| --- | --- | --- | --- |
| 0–6 | intro | FOR PEOPLE AND THEIR AGENTS · "A drive that holds more than your laptop." · "Plain files in object storage, opened by the apps you already use." | — |
| 6–17 | hero | THE DRIVE · "Plain files, opened by the apps you already use." | `public/index.html` hero |
| 17–28 | huge files | HUGE FILES · "A 5 GB video starts without a 5 GB download." | `public/index.html` finder section |
| 28–40 | agents | EVERY AGENT · "Agent keys can list, read and write. They can never delete." | `public/index.html` agents section |
| 40–52 | price | ONE PRICE · "2¢ per GB a month. Never more than $15 per TB." | `public/index.html` calculator |
| 52–64 | cap | THE CAP · "At the cap, writes stop. Every file stays." | `public/index.html` cap section |
| 64–75 | cta | drive · "Get drive." · "The drive is not open yet. Sign-ups go to the waitlist." · "Join the waitlist on the drive site." | — |

## Claims and their sources

| on-screen claim | source |
| --- | --- |
| "A drive that holds more than your laptop." | `README.md:4` ("a folder on macOS or Linux that holds more than the laptop does") |
| "Plain files in object storage, opened by the apps you already use." | `README.md:4` ("Your files live in object storage and open on demand") and `README.md:8` ("Real names, opened by the apps you already use") |
| "A 5 GB video starts without a 5 GB download." | `public/index.html` finder section ("A 5 GB video starts without a 5 GB download.") — measured on the page |
| "Agent keys can list, read and write. They can never delete." | `public/index.html` agents section; `README.md` ("an agent key can list, read and write, but it can never delete") |
| "2¢ per GB a month. Never more than $15 per TB." | `public/index.html` calculator subhead ("2 cents per GB until the bill reaches $15, at 750 GB") and its metered note; `README.md` pricing line; the rule is min(2¢ × size30 GB, $15 × max(1, size30 TB)) in `core/billing.js` (drive#642) |
| "At the cap, writes stop. Every file stays." | `public/index.html` cap section ("A cap that stops writes, not files.") |
| "The drive is not open yet. Sign-ups go to the waitlist." | `public/index.html` waitlist copy |
| "Join the waitlist on the drive site." | no host is printed, on purpose. `storagebun.com` answers `302` to a Cloudflare Access login for anyone logged out, so a printed URL is a dead end. Verified 2026-10-06. |

## Music

No music. The video ships silent, so there is no track licence to clear.

## Screens

The five product frames are real screenshots of the Storagebun web pages, captured from
`public/index.html` served locally (the production site is behind Cloudflare
Access). Captures are 1920x1080 with the page ticker hidden so no frozen
animation appears in the stills.

## Fonts

The five woff2 files under `assets/fonts/` are the same ones the pages ship
(`public/fonts/`). They are SIL Open Font License 1.1, and each family's OFL text
is copied in beside it: `big-shoulders-display-OFL.txt`, `instrument-sans-OFL.txt`
and `jetbrains-mono-OFL.txt`.

## References

Three HyperFrames renders by the HeyGen team, used for look and pacing only. They
were downloaded to the VPS for study and are not in git. YouTube refused the VPS
("Sign in to confirm you're not a bot"), so the references come from the
HyperFrames repository (Apache-2.0) instead.

| reference | what we took |
| --- | --- |
| [HyperFrames README demo](https://github.com/user-attachments/assets/f6ff9fae-f33d-4f68-bd54-f3ed4ba6473b) (5 s) | a real product screen, typed into on a dark field: show the product, not a mock-up |
| [`style-4-prod` render](https://github.com/heygen-com/hyperframes/blob/main/packages/producer/tests/style-4-prod/output/output.mp4) (17 s, 1920x1080) | the main frame beside a short labelled callout that slides in |
| [`style-5-prod` render](https://github.com/heygen-com/hyperframes/blob/main/packages/producer/tests/style-5-prod/output/output.mp4) (19 s, 1920x1080) | a typed mono intro line, then one large caption per beat |

## Animation library

`assets/gsap-3.14.2.min.js` is GSAP 3.14.2, copied byte for byte (sha256
`c174bfce…8280`). Its own header keeps the copyright line and points to its
licence, the GSAP Standard "no charge" License (https://gsap.com/standard-license).
Its terms allow use "at no charge in commercial or non-commercial apps, web
sites, games, components, and other software as long as end users are not charged
a fee of any kind". Nobody pays to watch this video, so it fits.
