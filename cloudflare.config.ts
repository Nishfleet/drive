import { bindings, defineConfig, triggers } from "cf/config";
import * as entrypoint from "./src/index.js" with { type: "cf-worker" };

// The cron trips this Worker runs, spelled out below in `triggers` and
// read back out of the modules that own them — core/meter.js (METER_CRON,
// METER_RECONCILE_SCHEDULE), src/search.js (REINDEX_SCHEDULE),
// src/account-close.js (CLOSE_SCHEDULE) and src/malware.js
// (KNOWN_BAD_FEED_SCHEDULE) — by the `scheduled` handler in src/index.js.
//
// They are spelled in both places on purpose, and this import list is why it
// must: an import here is a *config dependency*. @cloudflare/config executes
// this file to read it, and every plain import it follows lands in the
// dependency set the Cloudflare Vite plugin adds to Vite's `server.fs.deny`
// list. Vite then refuses to read any of those files in `cf dev`, so a config
// that imports core/meter.js or src/search.js for a cron string drags the whole
// shared Worker graph behind it (core/files.js, core/messages.js, core/status.js,
// core/auth.js, core/db.js) and `npm run dev` dies with `Failed to
// load url /src/auth.js ... Does the file exist?` before it prints a route
// (drive#432). test/meter.test.mjs pins the two halves together string by
// string, so the schedule here cannot drift from the one src/index.js
// answers to.
//
// The `entrypoint` import above is the exception that proves the rule: it
// carries `with { type: "cf-worker" }`, so @cloudflare/config records the
// specifier without loading the module, and it never reaches the deny list.

// drive issue #11: the pricing and landing page, served as Worker static
// assets, with /api/* routed to the Worker for the waitlist form and the
// meter's event intake.
export default defineConfig({
  worker: {
    name: "drive-pricing",
    compatibilityDate: "2026-09-29",
    // Private until launch (Nish, 2026-10-01). The workers.dev address is
    // on only behind Cloudflare Access ("All traffic", Cloudflare account
    // members); the deploy fails if a stranger ever reaches the site without
    // the sign-in. No preview URLs.
    //
    // storagebun.com (drive issue #870) is the site's own domain, so the
    // public pages, the sitemap, robots.txt and llms.txt all carry it.
    // `domains` is the Worker custom domain: one line here is what puts the
    // Worker on the zone, the same way wrangler's `routes` with
    // `custom_domain: true` does it. The workers.dev address stays on until
    // the custom domain answers for real (issue #870: removing it is a
    // separate, verified step). Nameservers are still at the registrar, so
    // this line attaches the hostname inside the Cloudflare zone and does
    // not publish it. Access must cover storagebun.com before nameservers
    // move, or the pre-launch site would answer a stranger (drive#159).
    // test/access-wall.test.mjs fails a 200 from the hostname. The deploy
    // workflow's matching check is drive#872 (this token cannot push
    // workflow files).
    domains: ["storagebun.com"],
    workersDev: true,
    previewUrls: false,
    entrypoint,
    // Everything that is not /api/* is served straight from the asset
    // layer, so the page never pays for a Worker invocation. /api/* runs the
    // Worker; the Worker's own fallthrough to ASSETS.fetch keeps a stray
    // path an asset 404 instead of a hand-rolled error page.
    assets: {
      // runWorkerFirst sends /api/* and the share links here; the branch just
      // has to come before the asset fallthrough. /s/<token> is a logged-out
      // share link served by the Worker (src/share.js
      // handleShareFileRequest); the rest of the site is still straight from
      // the asset layer.
      //
      // /v1/* is the api Worker's family, on this same host (drive#156/#341,
      // #342): the CLI posts it to the one APIBase it posts /api/* to, so the
      // Worker that answers that address has to be the one that receives it.
      // It forwards the request over a service binding (src/index.js) rather
      // than serving it, so the api Worker's own gate, limits and words answer
      // it. The binding itself is not declared here yet: Cloudflare fails this
      // Worker's deploy against a service binding whose target Worker does not
      // exist, and the api Worker is a separate deployable that no deploy ships
      // until its deploy step lands, so until then /v1/* is the closed door
      // src/index.js answers rather than a family that pretends to be routed.
      runWorkerFirst: ["/api/*", "/s/*", "/v1/*"],
      notFoundHandling: "404-page",
    },
    // Five Cron Triggers: the meter's hourly rollup (drive issue #6), the
    // meter's nightly reconciler (drive issue #59), the file index's
    // nightly reconciler (drive issue #18), the nightly trash purge
    // (drive issue #521), and the account close cron (drive issue #522).
    // `scheduled` in src/index.js tells
    // them apart by the cron string the platform hands it, so no trigger
    // spends another's work. The reindex schedule is the only way a rebuild
    // starts, so no web request can spend the walk (the safety review: reindex
    // is not a public route). 03:00 UTC is the spec's quiet hour, before the
    // meter's first hourly run; the meter's reconciler runs at 04:00 UTC, an
    // hour later, so the two nightly walks do not share a trip; the trash
    // purge runs at 05:00 UTC, after the reconciler, so a parked file's last
    // hour is re-rolled before its bytes leave the bucket; the account close
    // cron runs at 06:00 UTC, after the purge, on the same blast-radius rule
    // that keeps it off the 04:00 reconcile's trip.
    //
    // Each schedule is the string the module that owns it exports:
    // core/meter.js's METER_CRON and METER_RECONCILE_SCHEDULE,
    // src/search.js's REINDEX_SCHEDULE, core/files.js's
    // TRASH_PURGE_SCHEDULE, and src/account-close.js's CLOSE_SCHEDULE.
    // test/meter.test.mjs reads these five
    // out of this file and asserts they equal those exports, so a changed
    // schedule cannot drift from the trigger that runs it. They are not
    // imported from those modules - see the note at the top of this file for
    // why an import here breaks `npm run dev` (drive#432).
    triggers: [
      triggers.scheduled({ schedule: "5 * * * *" }),
      triggers.scheduled({ schedule: "0 4 * * *" }),
      triggers.scheduled({ schedule: "0 3 * * *" }),
      triggers.scheduled({ schedule: "0 5 * * *" }),
      // The account close cron, on its own trip (drive#522, CLOSE_SCHEDULE
      // in src/account-close.js). It used to share the 04:00 reconcile's
      // trigger, which gave a metering failure one blast radius big enough to
      // delay every close receipt, reminder and purge behind it; the nightly
      // trash purge (drive#521) took 05:00 in the same window, so the close
      // cron runs after it, at 06:00 UTC.
      triggers.scheduled({ schedule: "0 6 * * *" }),
      // The known-bad feed load (drive#826, KNOWN_BAD_FEED_SCHEDULE in
      // src/malware.js): the Cron Trigger that reads the stock public
      // MalwareBazaar SHA-256 list into D1. It runs last of the nightly trips,
      // after the close cron, and it is the only one of this Worker's cron
      // trips that makes an outbound call — the request path reads the table
      // it fills.
      triggers.scheduled({ schedule: "0 7 * * *" }),
      // The nightly reindex's consumer (drive#566). The 03:00 cron enqueues
      // one message per account on this queue, and each message is consumed
      // on its own: maxBatchSize 1 is one account per invocation, so a
      // broken account cannot spend a sibling's retry budget, which is what
      // the serial loop this replaces did. maxRetries 2 gives a failed walk
      // its own retry budget. There is no dead-letter queue yet: after the
      // retries the message is dropped, the nightly cron enqueues the
      // account again, and a message is lost for at most a day (#519 tracks
      // the meter crons' dead-letter queues; the reindex can join them).
      // The queue is created once, out of band, like the branch-snapshot
      // namespace below: a deploy cannot provision one, and `ensureQueuesExistByConfig`
      // fails the deploy with
      //   Queue "drive-reindex" does not exist. To create it, run:
      //   cf queues create drive-reindex
      triggers.queue({
        name: "drive-reindex",
        maxBatchSize: 1,
        maxRetries: 2,
      }),
      // One message per account from the meter crons (drive#519). Both
      // queues were created on the account on 2026-10-06; see the note at
      // the top of src/meter-jobs.js. Remove this and METER_JOBS to go back
      // to the in-process loop.
      triggers.queue({
        name: "drive-meter-jobs",
        deadLetterQueue: "drive-meter-jobs-dlq",
        maxRetries: 5,
        maxBatchSize: 10,
      }),
    ],
    // Issue #520: failures were invisible because this key was absent — the
    // Worker shipped with observability off, so `console.error` in the cron
    // branches and `app.onError` went nowhere a human looks. Workers Logs
    // collects every invocation's console lines for 14 days (the default
    // sampling here is 1, everything), which is the floor; the pipeline that
    // pages a human is Sentry, wired in src/monitoring.js off the
    // per-deployment SENTRY_DSN var (the docs runbook has the setup).
    observability: {
      enabled: true,
      headSamplingRate: 1,
    },
    env: {
      ASSETS: bindings.assets(),
      METER_JOBS: bindings.queue({ name: "drive-meter-jobs" }),
      // Branch copy/approve/discard/rewind (drive#563). The producer rides the
      // meter queue that already exists, because a deploy that names a queue
      // which does not exist fails. Message kinds are `branch.*` vs `meter.*`,
      // and src/index.js's queue handler splits the batch. A dedicated
      // `drive-branch-jobs` queue is a later bind-name change once it is
      // created out of band (`src/branch-jobs.js`).
      BRANCH_JOBS: bindings.queue({ name: "drive-meter-jobs" }),
      // Two databases, one purpose each (drive issue #170). The waitlist's
      // table lives alone in the waitlist database: the sign-up list is
      // public data and can be exported, reset or handed on without
      // touching a customer's files. Everything that belongs to a
      // customer lives in the drive database. The two migration
      // directories mirror the split — `migrations/waitlist/` applies to
      // WAITLIST_DB and `migrations/drive/` to DRIVE_DB — and the deploy
      // must apply both before it ships the Worker; that deploy step is
      // tracked in the follow-up for #170 (the worker App cannot write
      // workflow files), so the config alone cannot enforce it here.
      WAITLIST_DB: bindings.d1({
        name: "drive-waitlist",
        id: "93c9f523-159c-4261-8541-d4c059906df3",
      }),
      DRIVE_DB: bindings.d1({
        name: "drive-data",
        id: "0f636b57-4a2e-482a-bf40-8aa315e2403e",
      }),
      // The meter binds the same drive database under a name of its own (drive
      // issue #6): core/meter.js says which tables it owns and which binding
      // carries them, so the customer-data split is a binding line here rather
      // than a code change in the meter. Same database, so same id:
      // file_versions, usage_minutes, events_seen and meter_rollup_state
      // (migrations/drive/0005_meter.sql) are created and read beside the file
      // index, and giving them a database of their own is this line alone.
      METER_DB: bindings.d1({
        name: "drive-data",
        id: "0f636b57-4a2e-482a-bf40-8aa315e2403e",
      }),
      // The branch snapshot store (drive issue #252, the phase 2 of #157). A
      // branch records one `{size, etag, modified}` entry per file it copied;
      // that is ~117 bytes a file, so a 100,000-file branch is ~11 MiB of JSON
      // — twelve times D1's 1 MiB row limit, which is why phase 1 refused it
      // and why the snapshot now lives here instead. drive#563 runs copy,
      // approve, discard and rewind as queued jobs in file batches so the
      // 10,000-subrequest ceiling is no longer the cap; 100,000 files is still
      // the remaining size limit (`BRANCH_FILE_LIMIT` in src/branches.js)
      // because that snapshot has to sit in memory. BRANCH_JOBS produces onto
      // the existing `drive-meter-jobs` queue (kinds `branch.*`) until a
      // dedicated queue is created out of band (`src/branch-jobs.js`). The
      // `branches` row
      // keeps a pointer to the key and the value's byte length
      // (migrations/drive/0012_branch_snapshot_kv.sql). Since drive#329 the
      // leftover column is unread and unwritten: `readSnapshot` takes the
      // pointer only, and a missing namespace is a 503 on every branch and
      // rewind route. The binding is on src/health.js `REQUIRED_BINDINGS`.
      // It is created once, out of band, because an unattended `cf deploy`
      // does not provision a namespace (it prompts, and nothing answers):
      //   cf kv namespaces create --title drive-branch-snapshots
      BRANCH_SNAPSHOTS: bindings.kv({
        id: "13f2292d4fdc448492c2a4603e1cc682",
      }),
      // The reindex queue's producer half (drive#566). The 03:00 cron sends
      // one `{accountId}` message per account on it, and the same Worker
      // consumes it (`queue` in src/index.js; the consumer trigger is above).
      // Only an account id is in a message: the walk is scoped to that
      // account's own prefix, so a message can name no file and no other
      // account's bytes. Like the namespace above it, the queue is created
      // once, out of band:
      //   cf queues create drive-reindex
      REINDEX_QUEUE: bindings.queue<{ accountId: string }>({ name: "drive-reindex" }),
      // The meter's event intake (drive issue #6) reads METER_EVENT_TOKEN
      // from a Worker secret. The secret binding declares the name so the
      // runtime knows to inject it; a missing secret produces a warning at
      // dev/deploy, and the handler fails closed with 503 until it is set. Set
      // it once, the same way the email token is set (it persists across
      // deploys):
      //   cf workers secrets update METER_EVENT_TOKEN --type secret_text \
      //     --text <token> --worker drive-pricing
      // (--type is required: cf refuses the update without it. #189: the
      // secret survives a deploy because cf 1.0.0-beta.7 and later inherit
      // secret bindings from the previous Worker version.)
      METER_EVENT_TOKEN: bindings.secret(),
      // drive issue #28: bound the waitlist endpoint. Five sign-ups a
      // minute per client IP is far above a person's pace and far below
      // what a script needs to enumerate addresses or fill the table.
      // Cloudflare requires the namespace to be a positive integer
      // string, unique per account; a name fails the deploy with 10021.
      WAITLIST_RATE_LIMITER: bindings.rateLimit({
        namespace: "1001",
        simple: { limit: 5, period: 60 },
      }),
      // drive issue #147: bound POST /api/signin at the edge, beside the
      // closed-door posture the sign-in route ships with (src/signin.js).
      // POST /api/signin mails a real email, so a script walking many
      // addresses is a mailbomb and a send-cost vector once the route is
      // open in production. Per IP it is far above the retries a person
      // makes from their own connection (10 a minute against a couple of
      // sign-in posts) and far below what a script needs to walk
      // addresses; the global one bounds the whole service. Both configs
      // are one minute, the waitlist's period, and both are turned on
      // before sign-in opens in production.
      //
      // The numbers are a pre-production guard, not a capacity answer, and
      // the honest caveat is shared egress: an office or CGNAT downlink
      // concentrates people onto one client IP, so `limit: 10` shapes the
      // whole office to 10 sign-ins a minute, not one person. Acceptable
      // while the site is behind Cloudflare Access; on the day sign-in
      // opens, measure the real sign-in rate and raise the per-IP (and the
      // global above it) first, before a customer shares their login
      // morning with a landline's worth of neighbours (#147's follow-up).
      //
      // The global ceiling is a spend bound, not a traffic shaper: it sits
      // far above the per-IP world it caps, and it caps the worst case at
      // 100 sends a minute however many addresses a distributed walk
      // touches.
      // Each binding needs its own namespace: Cloudflare wants a positive
      // integer string, and a namespace another binding already uses fails
      // the deploy. These are distinct from the waitlist's 1001.
      SIGNIN_RATE_LIMITER: bindings.rateLimit({
        namespace: "1002",
        simple: { limit: 10, period: 60 },
      }),
      SIGNIN_GLOBAL_RATE_LIMITER: bindings.rateLimit({
        namespace: "1003",
        simple: { limit: 100, period: 60 },
      }),
      // drive issue #208: bound POST /api/request/upload at the edge, beside
      // the spending cap the route already applies (src/share.js). A stranger
      // holding a link can otherwise stream files with no size or rate bound
      // and run the owner up to their cap. Per IP it is the sign-in figure
      // (10 a minute): far above a person dropping a handful of files, far
      // below a script filling a folder. Per link is the same number, so one
      // token cannot be walked from many IPs faster than one connection
      // already can. Both configs are one minute, the waitlist's period.
      // Each binding needs its own namespace: Cloudflare wants a positive
      // integer string, and a namespace another binding already uses fails
      // the deploy. These are distinct from the waitlist's 1001 and the
      // sign-in pair's 1002/1003.
      REQUEST_UPLOAD_RATE_LIMITER: bindings.rateLimit({
        namespace: "1004",
        simple: { limit: 10, period: 60 },
      }),
      REQUEST_UPLOAD_LINK_RATE_LIMITER: bindings.rateLimit({
        namespace: "1005",
        simple: { limit: 10, period: 60 },
      }),
      // drive#539: GET /api/health fans out to every D1, five other rate-limit
      // bindings, KV and ASSETS. The route itself sits behind this limiter so
      // an anonymous loop cannot spend those billed ops at will. 10 a minute
      // per IP is the sign-in figure: far above a monitor that polls once a
      // minute, far below a script. Namespace 1009, because 1006/1007 are the
      // api Worker's device pair (workers/api/cloudflare.config.ts) and 1008 is
      // the share-download limiter below.
      HEALTH_RATE_LIMITER: bindings.rateLimit({
        namespace: "1009",
        simple: { limit: 10, period: 60 },
      }),
      // GET /s/<token> (drive issue #506): a logged-out share download has no
      // account gate, so the stock rate-limit binding is the bound. Per IP it
      // sits at 60 a minute: far above a person opening a handful of links,
      // far below a script walking tokens. One minute, the waitlist's period.
      // Namespace 1008: 1001–1005 are this Worker, 1006/1007 are the api
      // Worker's device pair. A namespace another binding already uses fails
      // the deploy with 10021.
      SHARE_DOWNLOAD_RATE_LIMITER: bindings.rateLimit({
        namespace: "1008",
        simple: { limit: 60, period: 60 },
      }),
      // The two mint routes (drive issue #549): POST /api/share and POST
      // /api/request each get their own bound, on top of the per-account cap
      // of 50 open links the handlers enforce. 30 a minute per IP is far
      // above an owner clicking "Share" and far below a script minting tokens
      // to walk. Namespaces 1010/1011 continue the 1001-1009 series; a reused
      // namespace fails the deploy with 10021. 1010/1011 were free because the
      // HEALTH_RATE_LIMITER above took 1009, so test/deploy-api-worker.test.mjs
      // (which reads both this file and the api Worker's, and fails on the
      // first duplicate it finds) caught the SHARE_MINT_RATE_LIMITER reusing
      // it here.
      SHARE_MINT_RATE_LIMITER: bindings.rateLimit({
        namespace: "1010",
        simple: { limit: 30, period: 60 },
      }),
      REQUEST_MINT_RATE_LIMITER: bindings.rateLimit({
        namespace: "1011",
        simple: { limit: 30, period: 60 },
      }),
      // POST /api/branches (drive issue #553): a branch is a full server-side
      // copy of a folder, so a loop of creates costs the operator real storage
      // and real copy work. Per IP it sits at 10 a minute, the upload-request
      // limit: far above a person or agent making a handful of branches, far
      // below a script churning them. One minute, the family's period.
      // Namespace 1013: 1001-1005 are this Worker, 1006/1007 are the api
      // Worker's device pair, 1008 is the share download, 1009/1010 are the
      // health and download pair above, 1011 is this Worker's mint limit, and
      // 1012 is the api Worker's KEYS_RATE_LIMITER (drive#745), which landed
      // on main while this issue was in rework and took the number this
      // binding first chose. A namespace another binding already uses fails
      // the deploy with 10021, and test/deploy-api-worker.test.mjs fails on
      // the first duplicate it finds.
      BRANCH_RATE_LIMITER: bindings.rateLimit({
        namespace: "1013",
        simple: { limit: 10, period: 60 },
      }),
      // Cloudflare Email Sending (drive#33): the stock provider every
      // drive email goes through, in core/email-send.js. No options: the
      // binding is restricted by the domains onboarded for sending, and
      // the sender address is set per deployment, so nothing here pins a
      // brand domain before drive has one.
      EMAIL: bindings.sendEmail(),
      // The bearer token POST /api/emails/send requires, and the address
      // the emails come from. Both are secrets, never values in this
      // file: with the token unset the route answers 403 (a closed
      // door), and with no MAIL_FROM it answers 503, so it cannot be
      // used as a mail relay and cannot send from a placeholder domain
      // before drive has one. They are not declared here: a declared
      // secret is required, so the deploy refused to ship until both
      // were set, which contradicts the closed-door design. Set them
      // once drive has a sending domain (they persist across deploys):
      //   cf workers secrets update EMAIL_SEND_TOKEN --type secret_text \
      //     --text <token> --worker drive-pricing
      //   cf workers secrets update MAIL_FROM --type secret_text \
      //     --text <address> --worker drive-pricing
      // (--type is required: cf refuses the update without it.)
      //
      // drive issue #189: these two survive a deploy only because cf
      // 1.0.0-beta.7 and later inherit secret bindings from the previous
      // Worker version instead of dropping any not declared in this file
      // (https://github.com/cloudflare/cf/releases/tag/cf%401.0.0-beta.7).
      // On beta.5, the first deploy after either was set would have deleted
      // them, so the "closed door" above would have opened on a config that
      // read as closed. The lockfile pin is the gate on that behaviour.
    },
  },
});
