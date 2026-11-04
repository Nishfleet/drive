---
name: verify-drive
description: "Drive the Drive Worker (src/index.js, the pricing site and /api/* routes) locally with `npx cf dev`, prove a route works with a response, a D1 row, a trace and a screenshot, then tear it down. Use before claiming any change to src/, core/, public/ or migrations/ works, and for /verify-drive."
---

# verify-drive

Surface: one Cloudflare Worker (`drive-pricing`) served by `npx cf dev` (a Vite dev server). Pages come from `public/`, `/api/*` from `src/index-app.js`. The sibling `drive-api` Worker answers `/v1/*`. The `drive` CLI is Go and is not driven here (see `feature-map.md`).

Layout note: pstack's `/create-verification-skill` writes `.claude/skills/verify/` with a `features/` folder. This repo asked for `.claude/skills/verify-drive/` with one `feature-map.md`; `/maintain-verification-skill` accepts `verify-*` names. Everything else follows pstack's sections.

Use Node 24 (`.nvmrc`). `node_modules` must exist. Every command is stock; there is no helper script.

## Launch

1. Local secret. The Worker reads `METER_EVENT_TOKEN` (`/api/storage-events`). Without a value `cf dev` warns it is missing. Give it a dummy in `.dev.vars` at the repo root (gitignored; the Cloudflare doc says not to commit it, https://developers.cloudflare.com/workers/configuration/secrets/#local-development-with-secrets):
   `printf 'METER_EVENT_TOKEN="local-dummy-token"\n' > .dev.vars`
   Never put a real secret there. The doc names no `.dev.vars.example` pattern, so none is committed.
2. Fresh local D1. State lives in `.cloudflare/state` (gitignored). For a clean start run `rm -rf .cloudflare`, then apply both migration folders (https://developers.cloudflare.com/d1/best-practices/local-development/). The ids are the `WAITLIST_DB` and `DRIVE_DB` ids in `cloudflare.config.ts`:
   `npx cf d1 migrations apply <WAITLIST_DB id> --local --persist-to .cloudflare/state --dir migrations/waitlist`
   `npx cf d1 migrations apply <DRIVE_DB id> --local --persist-to .cloudflare/state --dir migrations/drive`
   Expect every migration to print a check mark. `cf dev` itself rejects `--persist-to` and uses `.cloudflare/state` by default, so the two meet.
3. Pick a free port: `ss -ltn | grep -E ':5173 |:5199 '`. Start in the background and record the port it printed:
   `npx cf dev --port 5199 > /tmp/verify-drive.log 2>&1 &`
   Vite does not fail on a busy port, it moves to the next one, so read the `Local:` line in the log, not your guess. Ready means the log has `Local:` and `curl -s -o /dev/null -w '%{http_code}' http://localhost:5199/` prints 200.

Set `B=http://localhost:5199` and `E=$B/cdn-cgi/local/explorer/api` for the rest.

## Doctor

Read-only. Run it first, and again after any failed drive.
- `ss -ltnp | grep :5199` shows the process you started (note its pid).
- `curl -s -o /dev/null -w '%{http_code}\n' $B/` is 200.
- `curl -s $E/d1/database` lists `WAITLIST_DB` and `DRIVE_DB` with their ids.
- `curl -s $B/api/health` answers 503 `{"ok":false,"failing":"storage",...}` locally. That is the expected local answer, because no storage bucket is bound. Anything that is not JSON means the wrong thing owns the port.

## Drive

Routes, curl lines and expected answers are in `feature-map.md`. Gated routes answer 401 without a session, and this skill does not mint a signed-in session (sign-in needs email), so the anonymous 401 text is the proof for them. Public routes can be driven fully. Send an `origin` header equal to `$B` on POSTs, or the CSRF check answers 403.

Worked example, waitlist:
`curl -s -X POST $B/api/waitlist -H "origin: $B" -H 'content-type: application/json' -d '{"email":"verify-probe@example.com"}'` answers 200.

## Evidence

Collect the action and the state it left, not just the status.
- Row: `curl -s -X POST $E/d1/database/<WAITLIST_DB id>/raw -H 'content-type: application/json' -d '{"sql":"SELECT * FROM waitlist"}'` returns the `verify-probe@example.com` row with source `pricing-page`.
- Span and log (the Local Explorer observability query, read-only SELECT over `spans` and `logs`): `curl -s -X POST $E/local/observability/query -H 'content-type: application/json' -d '{"sql":"SELECT service, name, outcome, duration_ms, json(attributes) FROM spans WHERE parent_id IS NULL ORDER BY start_ms DESC LIMIT 6"}'` shows the request with `http.response.status_code`. For the log line use `SELECT level, message FROM logs ORDER BY ts_ms DESC LIMIT 5`. Pages served straight from the asset layer (`/`) make no span; only Worker routes do.
- Screenshot (https://developer.chrome.com/docs/chromium/headless): `google-chrome --headless --no-sandbox --disable-gpu --window-size=1280,900 --screenshot=<dir>/home.png $B/` and then look at the PNG. A blank or error page is a failure even if the size is large.

Proof standards: use the real HTTP route, never a test-only endpoint or a direct D1 insert. The only mock is the missing storage bucket, which the app already treats as a closed door.

Save evidence in a directory outside the repo (for example `/tmp/verify-drive-evidence/`) and keep it after cleanup.

## Cleanup

Stop only what you started: `kill <pid from the ss line>` (the `cf-vite` node process, which is the port's listener). Never `pkill` by name; other sessions run their own dev servers. Then `ss -ltn | grep :5199` prints nothing. `rm -rf .cloudflare` and `.dev.vars` are scratch and may go; the evidence directory stays.

## Isolation

Two instances need different ports and different worktrees (`.cloudflare/state` is per checkout). Do not drive a port you did not start.

## Keeping it true

`README.md` in this folder says how to run `/maintain-verification-skill` so `feature-map.md` follows `src/index-app.js`.
