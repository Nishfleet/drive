# Feature map

One row per route registered in `src/index-app.js` (the Hono app `src/index.js` serves), in file order. `B` is the dev server and `H` is `-H "origin: $B"` (a POST without it fails the CSRF check). Gated means `accountGate` (`src/index-support.js`) answers 401 `You are not signed in to your drive...` with no session; public means the path is in `PUBLIC_ROUTES`. Every row's evidence includes the status and body; the column names the extras.

Expected answers are the anonymous local ones, observed with `npx cf dev` on a freshly migrated D1 and no storage bucket. This skill does not mint a signed-in session (sign-in needs email), so a gated route is proved by its 401 body.

| Route | Gate | How to reach it | Expected answer | Evidence |
| --- | --- | --- | --- | --- |
| `ALL /api/keys/revoke` | forwarded to `drive-api` | `curl -X POST $B/api/keys/revoke -d '{}'` | 500 `That did not work` locally (no api Worker behind the binding) | status+body |
| `GET,POST /api/auth/*` | public | `curl $B/api/auth/get-session` | 503 `Signing in is not open yet`; `/api/auth/nope` 404 `Not found.` | status+body |
| `ALL /v1/*` | forwarded to `drive-api` | `curl $B/v1/anything` | 500 `That did not work` locally | status+body |
| `GET /api/first-run-status` | gated | `curl $B/api/first-run-status` | 401 | status+body |
| `GET /api/search` | gated | `curl $B/api/search` | 401 | status+body |
| `GET,POST /api/files` and `/api/files/*` | gated | `curl $B/api/files` | 401 | status+body, span |
| `GET,POST /api/starter` | gated | `curl $B/api/starter` | 401 | status+body |
| `GET,POST /api/branches` and `/*` | gated | `curl $B/api/branches` | 401 | status+body |
| `GET,POST /api/rewind` and `/*` | gated | `curl $B/api/rewind` | 401 | status+body |
| `GET /api/usage` | gated | `curl $B/api/usage` | 401 | status+body |
| `GET /api/export` | gated | `curl $B/api/export` | 401 | status+body |
| `GET /api/balance` | gated | `curl $B/api/balance` | 401 | status+body |
| `GET,POST /api/milestones` | gated | `curl $B/api/milestones` | 401 | status+body |
| `GET,POST /api/history` | gated | `curl $B/api/history` | 401 | status+body |
| `GET,POST /api/webhooks`, `DELETE /api/webhooks/:id`, `POST /api/webhooks/:id/test`, `GET /api/webhooks/:id/deliveries` | gated | `curl $B/api/webhooks`; `curl -X DELETE $H $B/api/webhooks/x` | 401 | status+body |
| `GET /api/receipts/:id` | gated | `curl $B/api/receipts/x` | 401 | status+body |
| `POST /api/topup/auto`, `POST /api/topup` | gated | `curl -X POST $H -H 'content-type: application/json' -d '{}' $B/api/topup` | 401 | status+body |
| `GET /api/billing/portal` | gated | `curl $B/api/billing/portal` | 401 | status+body |
| `GET,DELETE /api/devices` and `/*` | gated | `curl $B/api/devices` | 401 | status+body |
| `GET,POST /api/cap` | gated | `curl $B/api/cap` | 401 | status+body |
| `GET,POST /api/account/close`, `POST /api/account/close/cancel` | gated | `curl $B/api/account/close` | 401 | status+body |
| `GET,POST,DELETE /api/share` | gated | `curl $B/api/share` | 401 | status+body |
| `GET,POST,DELETE /api/request` | gated | `curl $B/api/request` | 401 | status+body |
| `POST /api/waitlist` | public | `curl -X POST $B/api/waitlist $H -H 'content-type: application/json' -d '{"email":"verify-probe@example.com"}'` | 200; one row `verify-probe@example.com`, source `pricing-page`, in `WAITLIST_DB` table `waitlist` | D1 row, POST span with `http.response.status_code` 200, log line `POST .../api/waitlist` |
| `GET /api/quote` | public | `curl $B/api/quote` (no size) | 400 `That size is not a storage amount we can quote` | status+body |
| `POST /api/storage-events` | public, token | without a token: 401 `The event could not be accepted`. With the `.dev.vars` dummy as a Bearer `authorization` header and `-d '{}'`: 400 (the token passed, the empty event was refused) | status+body; proves `.dev.vars` loaded |
| `POST /api/storage-events/signed` | public | `curl -X POST $B/api/storage-events/signed -d '{}'` | 503 `not configured` (secret unset) | status+body |
| `POST /api/signin` | public | `curl -X POST $B/api/signin $H -H 'content-type: application/json' -d '{}'` | 400 `Choose one of: email, google, github.` | status+body |
| `GET /api/signin/verify` | public | `curl -i $B/api/signin/verify` | 302 | status, Location header |
| `GET,POST /api/signin/access` | public | `curl $B/api/signin/access` | 404 `Not found.` (no Access header locally) | status+body |
| `GET /s/*` (share link) | public | `curl $B/s/x` | 503 `The drive is not configured` (no storage) | status+body |
| `GET /api/request/info` | public | `curl $B/api/request/info` | 404 `That link does not open anything` | status+body |
| `POST /api/request/upload` | public | `curl -X POST $B/api/request/upload $H -d '{}'` | 503 `not configured` | status+body |
| `POST /api/billing/webhook` | public | `curl -X POST $B/api/billing/webhook -d '{}'` | 503 `Adding money is not open yet` | status+body |
| `GET /unsubscribe` | public | `curl -i $B/unsubscribe` | 404 HTML page (no token) | status |
| `POST /api/emails/send` | public, service only | `curl -X POST $B/api/emails/send -d '{}'` | 403 `only sent from the Storagebun service` | status+body |
| `GET /api/health` | public | `curl $B/api/health` | 503 `{"ok":false,"failing":"storage",...}` locally; 200 only with storage bound | status+body, span |
| `methodNotAllowed` fallthrough (`app.use "*"`) | n/a | `curl -X PUT $B/api/files` | 401 locally (the gate runs first) | status |
| Static pages: `GET /`, `/files`, `/signin` (asset layer, no Worker span) | public | `curl $B/`, then the screenshot command in SKILL.md | 200; hero reads `PAY 2 CENTS PER GB.` | screenshot of `/` |

## CLI rows

`drive init`, `drive mount` and `drive undo` (`cmd/drive/main.go`) need FUSE and rclone mounts, which this build server does not have, so this skill does not run them. They are proved in the CI `go` job (`.github/workflows/ci.yml`): read that job's result on the PR.

| Command | Proved by | Expected |
| --- | --- | --- |
| `drive init` | CI `go` job (`go test -race ./cmd/drive/ -short`) | green |
| `drive mount` | CI `go` job (`TestStandinMountProof`, `TestTwoDevicesKeepBothSaves`) | green |
| `drive undo` | CI `go` job (`go test -race ./cmd/drive/ -short`) | green |
