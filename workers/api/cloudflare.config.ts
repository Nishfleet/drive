// The api Worker's deploy config (drive issue #168).
//
// The site Worker's config is the root cloudflare.config.ts, and cf's
// autoconfig reads that path alone (the plugin's CONFIG_FILENAME is resolved
// against the Vite root, so a second file is not discovered by the CLI on its
// own). The api Worker is registered instead as an auxiliary Worker in
// vite.config.ts, which imports this file, so what is declared here is what
// `cf build` writes into the Build Output and what `cf deploy --worker
// drive-api` ships. The file is the one place both halves read: change a
// binding here and the build output and the deploy step change together, so
// this cannot drift into dead text.
//
// One host fronts both Workers (drive#156/#341): the CLI's one APIBase posts
// /api/* to the site Worker and /v1/* to this one. That routing, and the
// deploy step that ships this Worker next to the site Worker's, are tracked
// separately (the token a CI deploy runs under cannot write
// .github/workflows/), so this file declares the bindings and the build wires
// the Worker; the deploy and the route on the one base are the follow-up.

import { bindings, defineWorker } from "cf/config";

// The entrypoint is spelled from the project root, not from this file's own
// directory, because that is where the auxiliary Worker's config is consumed:
// the plugin resolves the entrypoint string against the Vite root
// (vite.config.ts imports this file, and the api Worker's real entry is
// workers/api/src/index.js). The root config names its entry with
// `with { type: "cf-worker" }`, which resolves to an absolute path only when
// loaded through @cloudflare/config's own loader — and a config file bundled
// into vite.config.ts loses that anchoring — so the plain root-relative path is
// what stays true here.
export default defineWorker({
  name: "drive-api",
  // The site Worker's compatibility date: the api Worker shares core/auth.js,
  // core/status.js and core/messages.js with it, and two Workers on two dates
  // drift in the runtime they run on.
  compatibilityDate: "2026-09-29",
  // No address of its own (drive#342): the site Worker forwards /v1/* here
  // over its `API` service binding, and the site sits behind Cloudflare Access
  // until drive has its own domain. A workers.dev address here would be a
  // second door with no Access app in front of it, so it stays off, and so do
  // preview URLs.
  workersDev: false,
  previewUrls: false,
  entrypoint: "workers/api/src/index.js",
  env: {
    // The drive database (drive issue #170): customer data, and nothing else.
    // The device sign-in store, the device token store, the team store and the
    // upload-queue report store all bind this one database (workers/api/src/
    // index.js reads it as env.DRIVE_DB), and Better Auth's own user and
    // session tables live on it too (core/auth.js, migrations/drive/
    // 0005_better_auth.sql), so an approve resolves one account across both
    // Workers. Same name and same id as the site Worker's DRIVE_DB: the
    // accounts store #161 asked for is that same user table — Better Auth's
    // instance is on this database (#181) — so a session in one Worker is the
    // same account in the other, and there is no second binding to declare.
    DRIVE_DB: bindings.d1({
      name: "drive-data",
      id: "0f636b57-4a2e-482a-bf40-8aa315e2403e",
    }),
    // The two edge limits the device flow answers behind (drive issues #147
    // and #168). Both fail closed where the deployment does not declare them
    // (workers/api/src/device-routes.js), which is the closed door this
    // binding exists to open.
    //
    // Per IP, 60 a minute, five times the 12 a well-behaved CLI already polls
    // (a device code is polled every DEVICE_CODE_INTERVAL_SECONDS = 5,
    // core/device-signin.js). It stays far below what a script needs to walk
    // short user codes.
    //
    // Sized on this flow's own load, deliberately not on the site Worker's
    // sign-in ceiling. The two guard different things — this one bounds short
    // user codes on the device flow, that one bounds sign-in posts — and
    // drive#202 raised the sign-in per-IP limit from 10 to 500 after
    // measuring a 200/min shared-egress peak, which left no room to keep this
    // number above it. The CLI's 12-a-minute poll is the load this ceiling has
    // to absorb (test/deploy-api-worker.test.mjs), and the two are now free to
    // move on their own measurements.
    //
    // The global one bounds the token factory: both a poll (which mints a
    // device token) and an approval (which attaches a signed-in account) are
    // public, so the ceiling is a spend bound on the worst case whatever many
    // IPs it comes from, and it sits far above the per-IP world it caps.
    //
    // Each binding needs its own namespace: Cloudflare wants a positive
    // integer string unique per account, and a namespace another binding
    // already uses fails the deploy with 10021. The site Worker holds 1001
    // (waitlist), 1002/1003 (sign-in), 1004/1005 (request-upload), 1008
    // (share download), 1009 (health) and 1010/1011 (share and request mint).
    // This Worker's device pair is 1006/1007 and the key-mint limiter below
    // is 1012. Both
    // configs are one minute, the waitlist's period, so one number describes
    // every rate limit on this account.
    DEVICE_RATE_LIMITER: bindings.rateLimit({
      namespace: "1006",
      simple: { limit: 60, period: 60 },
    }),
    DEVICE_GLOBAL_RATE_LIMITER: bindings.rateLimit({
      namespace: "1007",
      simple: { limit: 600, period: 60 },
    }),
    // drive issue #552: the per-account limit the key mint runs behind, ahead
    // of the live-key count cap the store enforces. The count caps what an
    // account may hold (20 live keys, keyprovider.js KEY_COUNT_CAP); this one
    // caps how fast mints are tried — 10 a minute per account, far above a
    // person's pace (one key per device or tool, a handful in a sitting) and
    // far below what a looping script needs to matter before the next
    // nightly sweep. Keyed on the account id, not the client IP: the caller
    // is signed in, and one account's loop must not spend another account's
    // quota. Unlike the device pair it does not fail closed at the route on a
    // missing binding (the account gate and the count cap bind the route
    // anyway), but the deploy config gate refuses to ship without it, which
    // is what makes the name load-bearing.
    // Namespace 1012: 1001–1005 and 1008–1011 are the site Worker, 1006/1007
    // are this Worker's device pair. A namespace another binding already uses
    // fails the deploy with 10021.
    KEYS_RATE_LIMITER: bindings.rateLimit({
      namespace: "1012",
      simple: { limit: 10, period: 60 },
    }),
    // Device approval mails the owner (drive#518). Same stock send_email
    // binding the site Worker uses; MAIL_FROM stays undeclared so a missing
    // sending domain is a skipped notice, not a refused deploy.
    EMAIL: bindings.sendEmail(),
    // MAIL_FROM stays undeclared: a declared secret is required at deploy, and
    // the approval still finishes when the sending domain is unset. Set it
    // once beside the site Worker's own:
    //   cf workers secrets update MAIL_FROM --type secret_text \
    //     --text <address> --worker drive-api
    //
    // The other values this Worker reads from env that are not declared, for
    // the same reason the site Worker does not declare them
    // (cloudflare.config.ts): a declared secret is required at deploy, so the
    // deploy would refuse to ship until each was set, and every one of these
    // routes already answers its closed door without them — `authFor` returns
    // no instance with no BETTER_AUTH_SECRET or database, so every account
    // route 401s rather than bypassing the gate (core/auth.js), and with no
    // MAIL_FROM the sign-in link is a 503 that names the missing setting
    // (core/email-send.js). Set them once, beside the site Worker's own, and
    // they persist across deploys (cf 1.0.0-beta.7 and later inherit secret
    // bindings from the previous Worker version, drive issue #189):
    //   cf workers secrets update BETTER_AUTH_SECRET --type secret_text \
    //     --text <secret> --worker drive-api
    //   cf workers secrets update BETTER_AUTH_URL --type secret_text \
    //     --text <base url> --worker drive-api
    //   cf workers secrets update MAIL_FROM --type secret_text \
    //     --text <address> --worker drive-api
    // The stand-in storage API, the bucket's event intake and the S3 key
    // provider read their own STORAGE_* values off env too (workers/api/src/
    // index.js, s3-keys.js, event-routes.js), all set the same way per
    // deployment; the stand-in credential is what the Worker falls back to
    // when a deployment leaves them unset.
    // The same is true of IDRIVE_E2_API_TOKEN, the iDrive e2 reseller token:
    // storage is a per-deployment choice (stand-in, B2, iDrive e2), so no
    // storage credential is declared, and a deployment that chose iDrive sets
    // the token with `cf workers secrets update IDRIVE_E2_API_TOKEN --type
    // secret_text --text <token> --worker drive-api`.
  },
});
