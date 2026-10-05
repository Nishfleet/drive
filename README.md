# Drive

A Finder drive for people and their agents: a folder on macOS or Linux that
holds more than the laptop does. Your files live in object storage and open on
demand, so a 5 GB video starts without a 5 GB download. Your agents read and
write the same folder.

- **Plain files.** Real names, opened by the apps you already use. Nothing is
  packed into a database.
- **Version history is not in version 1.** Saving a file again replaces it. A
  delete from the Files page is restorable for 30 days in Recently deleted, and
  a delete made any other way is recoverable for one day, by asking us. The
  full list of what version 1 does not do is on the
  [Limits page](https://drive-pricing.nishant345.workers.dev/docs/limits).
- **An agent's delete is undoable for 1 day.** An agent gets its own key. The
  storage takes that key's delete but keeps the deleted copy for 1 day, and we
  can put it back if you ask within that day. After that it is gone. A branch key reaches your whole Drive, not only its branch, because the
  storage limits a key to the whole Drive.
- **One price.** Add $10 or more. Pay 2 cents per GB from your balance. Never more than $10 per TB.
  No plans. Your balance never expires.
- **A card at sign-up.** We need a card at sign-up because there is no free tier. Your first $10 top-up opens storage. 20 GB draws about 40 cents a month from your balance.
- **A cap you set.** At the cap the drive goes read-only: nothing is deleted and
  the bill stops.

**The drive is not open yet. Sign-ups on the pricing page go to a waitlist.**

## Docs

The docs are the reference, built from this repository so the numbers on a page
and the numbers on the invoice cannot drift apart. Each page is also served as
Markdown (add `.md` to the address), and the whole set is in one file for
agents.

- [Quickstart](https://drive-pricing.nishant345.workers.dev/docs/quickstart) —
  five steps to a mounted drive
- [How it works](https://drive-pricing.nishant345.workers.dev/docs/how-it-works) —
  plain files, the cache, restore, the bill
- [Agents](https://drive-pricing.nishant345.workers.dev/docs/agents) —
  `drive init` per tool, and what an agent key cannot do
- [Pricing and your bill](https://drive-pricing.nishant345.workers.dev/docs/pricing) —
  the rate, the maximum and four worked sizes
- [FAQ](https://drive-pricing.nishant345.workers.dev/docs/faq) — the questions
  we can answer with a measured number
- [Limits](https://drive-pricing.nishant345.workers.dev/docs/limits) — what
  version 1 does not do
- [Benchmarks](https://drive-pricing.nishant345.workers.dev/docs/benchmarks) —
  measured speed, including where we lose
- [Security](https://drive-pricing.nishant345.workers.dev/docs/security) — who
  can see your files
- [Changelog](https://drive-pricing.nishant345.workers.dev/docs/changelog) —
  one line per shipped thing
- [`llms.txt`](https://drive-pricing.nishant345.workers.dev/llms.txt) and
  [`llms-full.txt`](https://drive-pricing.nishant345.workers.dev/llms-full.txt)
  — the same words, for an agent

The docs pages are authored in [`docs-site/`](docs-site/) and built by VitePress
into the site's static assets: `npm run docs:build`. Every number on a page
comes from `src/billing.js` at build time, so a test fails the build if a page
and the invoice disagree.

## The repository

| Path | What it is |
| --- | --- |
| `cmd/drive/` | the `drive` CLI (Go), with its tests beside it |
| `src/` | the site Worker: the route table in `index.js`, the files, share, search, usage, cap and waitlist handlers, the meter, and the money in `billing.js` |
| `test/` | the site Worker's tests (`*.test.mjs`), `integration/` for the D1 ones, and `harness.mjs` for the shared sign-in test setup |
| `workers/api/` | the api Worker: keys, device sign-in, teams, export and storage events (`src/`, tests in `test/`) |
| `workers/dl/` | the download Worker (`src/`, tests in `test/`) |
| `public/` | the static pages (pricing, sign-in, files, usage, upload), `site.css`, `robots.txt` and `llms.txt`. `public/docs/` is generated and never committed |
| `get-started.html` | the get-started page, at the repo root so Vite builds it to `/get-started.html` |
| `docs-site/` | the docs pages and the VitePress build |
| `docs/` | the build spec and spec, the API notes, the scoreboard, benchmarks, `research/` and `design/` |
| `migrations/` | D1 migrations, split by database: `waitlist/` for the sign-up table, `drive/` for customer tables |
| `cloudflare.config.ts` | the Worker, its D1 bindings (`WAITLIST_DB`, `DRIVE_DB`), secrets and cron triggers |

Run `npm ci` first, on Node 24 (`.nvmrc`; `nvm use` picks it up). `npm run dev`
starts the site Worker and the api Worker on <http://localhost:5173>. `npm test`
typechecks, lints, builds the docs and runs the test suite. An older Node stops
with the version it found and the version the repo needs, because the test
adapter uses `node:sqlite`, which is experimental before Node 24.
To run one test file, build the docs once (`npm run docs:build`), then `node --test test/x.test.mjs`.
`go test ./...` runs the CLI's tests.
To install the CLI from a tagged release, use the package-manager line
`drive --help` prints. To build from this checkout: `go build -o drive ./cmd/drive`.

The spec is [`docs/build-spec.md`](docs/build-spec.md) (what to build, step by
step) and [`docs/spec.md`](docs/spec.md) (why: prices, rivals).
