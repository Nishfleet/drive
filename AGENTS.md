# Agent notes for drive

A Finder drive for people and their agents: plain files in object storage, mounted with stock rclone, billed at 2¢ per GB-month by the minute.

- The spec is `docs/build-spec.md` (what to build, step by step) and `docs/spec.md` (why: prices, rivals). These two repo files are the source. The vault copy under `02 Projects/competitor-clone/spec/` is a stale snapshot and is not kept in step: the vault is a private repo no worker can push to, and its copy of this spec is untracked (drive#89).
- Every build step's finish line is proven on real files and real accounts, cited by path, id or timestamp. A green test alone is not done.
- Stock tools only (rclone, the storage provider's versioning, lifecycle rules and scoped keys, Cloudflare Workers, D1 and Cron Triggers, Dodo, the MCP filesystem server). Hand-write only the product's own logic: the `drive` CLI, the api and dl Workers, the meter, and the web pages.
- No money is spent without Nish. Sign-up asks for a card and refuses an account without one (drive#387). No live charge runs while the Dodo key is unset (#325).
- Secrets live in the VPS credential store, never in this repo.
- The Mac is read-only for agents. Mac-only proofs (step 2) run on a GitHub macOS runner or are marked for Nish.

## Find your way

- The spec says what to build and why. The code and its tests say what is built. When they differ, the code wins, and the finished work is listed in `docs-site/changelog.md` and `docs/scoreboard.md`. `docs/build-spec.md` is 300 lines, so search it for the step you need instead of reading it whole.
- An issue can name a path that has moved. Check `README.md` ("The repository") before you search. The static pages are in `public/`, but `get-started.html` sits at the repo root and Vite builds it to `/get-started.html`.
- The site Worker is `src/index.js` (the route table). The api Worker is `workers/api/src/index.js`. The download Worker is `workers/dl/src/index.js`. The CLI is `cmd/drive/`. Each has its tests beside it: `test/` for the site Worker, `workers/*/test/`, and `cmd/drive/*_test.go`.
- `core/` is the code all three Workers share (drive issue #616). A module more than one Worker needs lives there, never in one Worker's own `src/`. `biome.json` refuses an import that crosses: a module in `src/` or `core/` may not import a `workers/**` tree, and a module in a Worker's own `workers/*/src/` may not import the site Worker's `src/`. So a cross-import fails `npm run lint`; the way to share a module is to move it into `core/` and import it from there. `test/pr-gate.test.mjs` gate 8 plants each crossing and proves the rule on every `npm test` run.
- The D1 bindings are `WAITLIST_DB` and `DRIVE_DB` in `cloudflare.config.ts`. There is no plain `DB`. Migrations live in `migrations/waitlist/` and `migrations/drive/`.

## Set up and check fast

- Run `npm ci` in a new checkout, and again after you merge `origin/main`. The packages are all in the root `package.json` (`workers/*` has none), so a stale `node_modules` fails with `Cannot find package 'validator'` or `'hono'`. This is not a bug in your change.
- promptfoo (the agent eval, `evals/agents/`) is its own npm project, pinned there and not in the root `package.json`. Install it with `npm ci --prefix evals/agents` and check the version with `evals/agents/node_modules/.bin/promptfoo --version` (about 160 MB). Do not run `npx` or `npm exec` for it: that downloads the whole package each time and fills a runner's 3 GiB memory limit (drive#257).
- `npm test` is the full gate: types, lint, the dead-export lint, the docs build, then every test. A single `node --test test/x.test.mjs` is the fast loop, but the docs tests need the built pages. If you see `... was not built` or `ENOENT ... public/docs`, run `npm run docs:build` once and retry. This is not a failure on main.
- Nothing dead is left exported. `npm run lint:exports` (knip, part of `npm run check` and so of `npm test`) fails on an export that nothing imports, and on a file nothing imports. A module that must keep an export lists the reason beside it and the entry points are in `knip.json`. Un-export rather than delete when the module uses the name itself. `knip.json` ignores `axe-core` because the a11y test loads it through `createRequire().resolve`, `rolldown` because the dl boot test dynamic-imports vite's bundler, and `zod` because #778 added it and nothing in this tree imports it yet.
- `npm run typecheck` writes the Worker types first (`pretypecheck`), so run it through npm, not bare `tsc`.
- The Cloudflare Web Analytics beacon is a build-time setting, not a Worker secret: `DRIVE_CF_BEACON_TOKEN` (the dashboard's 32-hex token) puts one deferred script in the six pages' `<head>` while `npm run build` emits them, and an unset setting leaves those pages byte for byte as they ship (`src/analytics.js`, `test/web-analytics.test.mjs`). It is a variable, not a secret: the token is in every visitor's HTML.
- To see only failures, pipe through `grep -E "^not ok|^# (pass|fail)"`.

## Known Worker secrets

Declared `bindings.secret()` names in `cloudflare.config.ts`. A PR that adds one lists it under 'Secrets to set' and stays draft until it is set on drive-pricing.

- `METER_EVENT_TOKEN`
- `IDRIVE_E2_API_TOKEN` (drive-api)

## Before you open a PR

Each line is a gate, not prose: the test or file after the dash is what enforces it. `test/pr-gate.test.mjs` fails when a line below names a file that is gone, and proves each gate against the same modules the Worker runs.

A PR that changes a metric in the scoreboard (`docs/scoreboard.md`) updates that row with its own measurement, and the price rows still match the code (`test/scoreboard.test.mjs`). A PR that makes a speed row faster also lowers that row in `bench/baseline.json` (`test/speed-ratchet.test.mjs`).

A PR that adds a `bindings.secret()` lists the secret's name in its body under 'Secrets to set' and stays draft until it is set on drive-pricing (`test/worker-secrets.test.mjs`).

- [ ] The route is in the `src/index.js` table, behind the account gate (`signedInAccount`, `core/status.js`) or on the public list there, with the anonymous-401 proof in `test/status.test.mjs`.
- [ ] Every read and write stays in the account its store was built for — `core/files.js` pins `u/${account}` into every storage key — and `test/pr-gate.test.mjs` proves, through the request path, that one account's requests can neither read nor list another account's bytes.
- [ ] Input is validated at the edge (`validatePath`, `safeFileName` in `core/files.js`; `test/files.test.mjs`), and a file leaves as an attachment or as preview bytes a browser cannot read as a page — the preview serves the file's kind, never the upload's claim, with `nosniff` and a sandbox (`core/files.js`).
- [ ] No secret in code, flags, logs or error text: gitleaks on every PR (`.github/workflows/ci.yml`) and the safety rules `test/messages.test.mjs` enforces on every string.
- [ ] Money is whole cents out of the one billing function, `monthBillCents` (`core/billing.js`), pinned by `test/billing.test.mjs`.
- [ ] Tests come first for core logic, and `npm test` is green before the PR; `.github/workflows/ci.yml` runs that same command with the helper-script ban and gitleaks beside it. `npm test` reaches Biome through `pretest` -> `check`, so `npm run lint` is part of what CI runs; `npm run format` writes the fix.
- [ ] User-facing failure words are the one table's (`core/messages.js`), and `test/messages.test.mjs` fails on a string that drifts from it.
- [ ] Customer-facing copy uses our words, never a rival's terms (`test/own-words.test.mjs`).
- [ ] The PR says what was proven on real records and what was not, with the path, id or timestamp that proves it (`docs/build-spec.md`).
