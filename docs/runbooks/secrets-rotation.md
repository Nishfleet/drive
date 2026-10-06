# Secrets rotation runbook

The Drive Worker and its deploy hold credentials. Rotate one at a time, deploy,
and check the health route after each one, so a bad value is the only change in
the failed window.

## The rule that never bends

A secret never sits in a shell argument, a log line, a commit or an issue. It
never goes into `--text <value>` where `ps` and the shell history can read it.
Set it in the Cloudflare dashboard (Workers -> drive-pricing -> Settings ->
Variables) or through a tool that reads the value from a file the operator
deletes afterwards.

## What is held, and what a missing value does

- `METER_EVENT_TOKEN` — the bearer token the meter's event intake requires. With
  it unset the route answers 503 (`src/meter.js:1652`, the check that fails
  closed). Declared in `cloudflare.config.ts`; a declared secret must be set
  before a deploy.
- `EMAIL_SEND_TOKEN` and `MAIL_FROM` — the token and sender for the email send
  route. With the token wrong the route answers 403; with no `MAIL_FROM` it
  answers 503 (`src/email-send.js:230,252`). Not declared as secrets, on
  purpose: they are set once Drive has a sending domain (drive#584 tracks that
  DNS work).
- `IDRIVE_E2_API_TOKEN` — the api Worker's credential for minting scoped keys.
  A rotation invalidates the old value, so a mounted drive asks for a new key at
  its next start.
- The storage key pair and the Dodo key and webhook secret — the object storage
  and payment credentials. Dodo is Nish's account, so a rotation there is his
  call.
- The CI credentials (`CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`,
  `CF_ACCESS_CLIENT_ID`, `CF_ACCESS_CLIENT_SECRET`): the names the deploy and
  health steps of `.github/workflows/deploy-production.yml` read. They live in
  the repo's Actions secrets, not in a Worker. The same rule holds: rotate in
  the GitHub and Cloudflare dashboards, never in a workflow file.

## The order

1. Mint the new value in the provider's dashboard.
2. Set it on the Worker (or on the Actions environment for a CI credential).
3. Deploy `main`.
4. Check `https://drive-pricing.nishant345.workers.dev/api/health` for
   `{"ok":true}`.
5. Revoke the old value in the provider's dashboard.
6. Write one line in a new issue: the secret's name, the date, and the health
   result after the rotation. Never the value.

If step 4 fails, roll the Worker back (see `docs/runbooks/incident.md`) and
re-check. A rotated credential and a code fault are told apart by the health
route naming (or not naming) a binding.
