# verify-drive

A project skill that launches the Drive Worker with `npx cf dev` and proves a route with a response, a D1 row, a trace and a screenshot. `SKILL.md` is the playbook, `feature-map.md` is one row per route in `src/index-app.js` plus the CLI rows. It ships no script.

## Keeping the map true

The map rots when a route is added, removed or changes its answer. Run `/maintain-verification-skill` (pstack) when a PR changes `src/index-app.js`, `PUBLIC_ROUTES` in `src/index-support.js`, or `migrations/`, and at least once a month. It:

1. reads `feature-map.md` against `src/index-app.js` and fixes missing, extra or dead rows;
2. drives every row live following `SKILL.md`, and checks the expected answer and evidence;
3. opens at most one PR that edits only this folder. A route that is broken in the app is reported, not papered over in the map.

Edit scope is this folder only. Run notes are kept out of the repo.
