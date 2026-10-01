import { bindings, defineConfig, triggers } from "cf/config";
import * as entrypoint from "./src/index.js" with { type: "cf-worker" };
import { METER_CRON } from "./src/meter.js";
import { REINDEX_SCHEDULE } from "./src/search.js";

// drive issue #11: the pricing and landing page, served as Worker static
// assets, with /api/* routed to the Worker for the waitlist form and the
// meter's event intake.
export default defineConfig({
  worker: {
    name: "drive-pricing",
    compatibilityDate: "2026-09-29",
    // Private until drive has its own domain (Nish, 2026-10-01). The
    // workers.dev address is on only behind Cloudflare Access ("All
    // traffic", Cloudflare account members); the deploy fails if a
    // stranger ever reaches the site without the sign-in. No preview URLs.
    workersDev: true,
    previewUrls: false,
    entrypoint,
    // Everything that is not /api/* is served straight from the asset
    // layer, so the page never pays for a Worker invocation. /api/* runs the
    // Worker; the Worker's own fallthrough to ASSETS.fetch keeps a stray
    // path an asset 404 instead of a hand-rolled error page.
    assets: {
      runWorkerFirst: ["/api/*"],
      notFoundHandling: "404-page",
    },
    // Two Cron Triggers: the meter's hourly rollup (drive issue #6) and the
    // file index's nightly reconciler (drive issue #18). `scheduled` in
    // src/index.js tells the two apart by the cron string the platform hands
    // it, so neither trigger spends the other's work. The reindex schedule is
    // the only way a rebuild starts, so no web request can spend the walk
    // (the safety review: reindex is not a public route); 03:00 UTC is the
    // spec's quiet hour, before the meter's first hourly run. Both schedules
    // are the constants the modules that own them export, so a changed
    // schedule cannot drift from the trigger that runs it.
    triggers: [
      triggers.scheduled({ schedule: METER_CRON }),
      triggers.scheduled({ schedule: REINDEX_SCHEDULE }),
    ],
    env: {
      ASSETS: bindings.assets(),
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
      // issue #6): src/meter.js says which tables it owns and which binding
      // carries them, so the customer-data split is a binding line here rather
      // than a code change in the meter. Same database, so same id:
      // file_versions, usage_minutes, events_seen and meter_rollup_state
      // (migrations/drive/0005_meter.sql) are created and read beside the file
      // index, and giving them a database of their own is this line alone.
      METER_DB: bindings.d1({
        name: "drive-data",
        id: "0f636b57-4a2e-482a-bf40-8aa315e2403e",
      }),
      // The meter's event intake (drive issue #6) reads METER_EVENT_TOKEN
      // from a Worker secret. The secret binding declares the name so the
      // runtime knows to inject it; a missing secret produces a warning at
      // dev/deploy, and the handler fails closed with 503 until it is set. Set
      // it once, the same way the email token is set (it persists across
      // deploys):
      //   npx wrangler secret put METER_EVENT_TOKEN
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
      // Cloudflare Email Sending (drive#33): the stock provider every
      // drive email goes through, in src/email-send.js. No options: the
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
      //   npx wrangler secret put EMAIL_SEND_TOKEN
      //   npx wrangler secret put MAIL_FROM
    },
  },
});
