# Incident runbook

What to do when the Drive site or its API is not answering. This is the
operator's own page, not a customer page: it names the signals, the rollback,
and the point where the decision is Nish's.

## First, is it real?

1. Read the health route. It answers `{"ok":true}` only when every bound
   dependency replies, and `{"ok":false,"failing":"<binding>"}` when one does
   not. The required bindings it checks are the names in `REQUIRED_BINDINGS`
   (`src/health.js:137`), which `test/health.test.mjs` holds against
   `cloudflare.config.ts`:

   ```
   curl -sS https://storagebun.com/api/health
   ```

   A response other than 200, or `ok:false`, is the start of an incident. The
   `failing` name is the first stopped dependency, never a secret, a query or a
   stack.

2. Read the status page (`/status`). It reports the same route, so it is the
   page a customer sees. If it cannot reach the route it says so.

3. If the route answers `ok:true` but a person reports a broken page, the fault
   is inside one route, not the dependencies. Go to "Where the signals are".

## Where the signals are

- **Deploy failed.** The deploy workflow
  (`.github/workflows/deploy-production.yml`) rolls the Worker back to the
  previous version automatically when a step after the live-version read fails
  (its "Roll back the Worker version" step). Read that run first.
- **Health named a binding.** `WAITLIST_DB`, `DRIVE_DB`, `METER_DB`,
  `BRANCH_SNAPSHOTS`, `ASSETS` and the rate limiters are the names it can report.
  A D1 name means a database is unreachable. An `ASSETS` name means a page will
  not serve.
- **Worker logs.** The `[pricing] request failed:` line (`src/index.js`
  `app.onError`) carries the message and stack for a request that threw. The
  site's own 5xx page (`public/500.html`, served by `app.onError`) is what a
  browser in that request sees: the response is pinned `cache-control:
  no-store` and `x-robots-tag: noindex`, so neither a browser nor a crawler
  keeps the error.
- **Access.** Until Drive has its own domain, the site sits behind Cloudflare
  Access. A stranger reaching the site instead of the Access sign-in is an
  incident in itself (drive#159).

## Roll back

The deploy workflow's rollback step deploys the remembered previous Worker
version at 100%:

```
npx cf workers deployments create --worker drive-pricing --strategy percentage \
  --versions "[{\"version_id\":\"<previous>\",\"percentage\":100}]"
```

Rollback is code, never data. D1, KV and the object storage sit outside the
Worker version, so a rollback does not undo a migration. See
`docs/runbooks/restore.md`.

## When to stop and reach Nish

Stop and hand the decision to Nish for the reserved classes: money or pricing,
privacy, security, legal, brand, product direction, customer-data deletion, and
any destructive or irreversible step. A suspected key leak, a suspected data
loss, or a payment fault is his call. Everything else: fix it, write the
timeline in a new issue, and leave the fix on a branch for review.

## After

Open one issue with: the first failing signal and its timestamp, the `failing`
name or the Worker log line, the action taken (rollback or forward fix), and the
customer-visible window. Link the deploy run and the issue from the status page
once it is fixed.
