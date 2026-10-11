# Storagebun

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
  [Limits page](https://storagebun.com/docs/limits).
- **An agent's delete is undoable for 1 day.** An agent gets its own key. The
  storage takes that key's delete but keeps the deleted copy for 1 day, and we
  can put it back if you ask within that day. After that it is gone. A branch key reaches your whole Storagebun, not only its branch, because the
  storage limits a key to the whole Storagebun. `drive init` mounts `~/Drive-agents/<tool>`
  for each tool on its own key, and the MCP server and the tool's allowed folders
  point there, not at your Storagebun. Windows is not in version 1, and the tool there
  still works inside your own Storagebun, because the agent mount is not proven there.
- **One price.** Add $10 or more. Pay 2 cents per GB from your balance. Never more than $15 per TB.
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

- [Quickstart](https://storagebun.com/docs/quickstart) —
  six steps to a mounted drive
- [How it works](https://storagebun.com/docs/how-it-works) —
  plain files, the cache, restore, the bill
- [Agents](https://storagebun.com/docs/agents) —
  `drive init` per tool, and what an agent key cannot do
- [Pricing and your bill](https://storagebun.com/docs/pricing) —
  the rate, the maximum and four worked sizes
- [FAQ](https://storagebun.com/docs/faq) — the questions
  we can answer with a measured number
- [When something goes wrong](https://storagebun.com/docs/troubleshooting) —
  the three commands, the log on each system, a lost laptop, your files out
- [Limits](https://storagebun.com/docs/limits) — what
  version 1 does not do
- [Benchmarks](https://storagebun.com/docs/benchmarks) —
  measured speed, including where we lose
- [Security](https://storagebun.com/docs/security) — who
  can see your files
- [Changelog](https://storagebun.com/docs/changelog) —
  one line per shipped thing
- [`llms.txt`](https://storagebun.com/docs/llms.txt) and
  [`llms-full.txt`](https://storagebun.com/docs/llms-full.txt)
  — the same words, for an agent

The docs pages are authored in [`docs-site/`](docs-site/) and built by VitePress
into the site's static assets: `npm run docs:build`. Every number on a page
comes from `core/billing.js` at build time, so a test fails the build if a page
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

## Private detail scan

Pull requests are scanned for private infrastructure detail: personal home
paths, the local seat config path, Tailscale addresses and names, and account
ids written next to an account id name. The rules are in
`.github/gitleaks-private-detail.toml` (they extend the gitleaks defaults). Only
the commits a PR adds are scanned, so old history cannot fail a PR. The job is
`private-detail-scan` and it is not a required check.

- Allow one line: put `gitleaks:allow` in a comment on that line.
- Switch it off: set the repository variable `PRIVATE_DETAIL_SCAN` to `off`
  (`gh variable set PRIVATE_DETAIL_SCAN --body off`). Delete the variable to
  switch it back on.
- Remove it: delete the `private-detail-scan` job and the rules file.
- The rules file is not named `.gitleaks.toml` on purpose, because gitleaks loads
  that name by itself and the full-history scans would start failing on old
  commits.
