# Agent notes for drive

A Finder drive for people and their agents: plain files in object storage, mounted with stock rclone, billed at 2¢ per GB-month by the minute.

- The spec is `docs/build-spec.md` (what to build, step by step) and `docs/spec.md` (why: prices, rivals). The vault copy under `02 Projects/spacefs-clone/spec/` is the source; update both together.
- Every build step's finish line is proven on real files and real accounts, cited by path, id or timestamp. A green test alone is not done.
- Stock tools only (rclone, the storage provider's versioning, lifecycle rules and scoped keys, Cloudflare Workers, D1 and Cron Triggers, Dodo, the MCP filesystem server). Hand-write only the product's own logic: the `drive` CLI, the api and dl Workers, the meter, and the web pages.
- No money is spent without Nish. Free tiers and free trials only; if a signup asks for a card, stop and mark the issue `agent-blocked` with that reason.
- Secrets live in the VPS credential store, never in this repo.
- The Mac is read-only for agents. Mac-only proofs (step 2) run on a GitHub macOS runner or are marked for Nish.

## Before you open a PR

Each line is a gate, not prose: the test or file after the dash is what enforces it. `test/pr-gate.test.mjs` fails when a line below names a file that is gone, and proves each gate against the same modules the Worker runs.

A PR that changes a metric in the scoreboard (`docs/scoreboard.md`) updates that row with its own measurement, and the price rows still match the code (`test/scoreboard.test.mjs`).

- [ ] The route is in the `src/index.js` table, behind the account gate (`signedInAccount`, `src/status.js`) or on the public list there, with the anonymous-401 proof in `test/status.test.mjs`.
- [ ] Every read and write stays in the account its store was built for — `src/files.js` pins `u/${account}` into every storage key — and `test/pr-gate.test.mjs` proves, through the request path, that one account's requests can neither read nor list another account's bytes.
- [ ] Input is validated at the edge (`validatePath`, `safeFileName` in `src/files.js`; `test/files.test.mjs`), and a file leaves as an attachment or as preview bytes a browser cannot read as a page — the preview serves the file's kind, never the upload's claim, with `nosniff` and a sandbox (`src/files.js`).
- [ ] No secret in code, flags, logs or error text: gitleaks on every PR (`.github/workflows/ci.yml`) and the safety rules `test/messages.test.mjs` enforces on every string.
- [ ] Money is whole cents out of the one billing function, `monthBillCents` (`src/billing.js`), pinned by `test/billing.test.mjs`.
- [ ] Tests come first for core logic, and `npm test` is green before the PR; `.github/workflows/ci.yml` runs that same command with the helper-script ban and gitleaks beside it.
- [ ] User-facing failure words are the one table's (`src/messages.js`), and `test/messages.test.mjs` fails on a string that drifts from it.
- [ ] The PR says what was proven on real records and what was not, with the path, id or timestamp that proves it (`docs/build-spec.md`).
