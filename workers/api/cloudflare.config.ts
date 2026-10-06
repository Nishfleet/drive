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
  // The same posture the site Worker ships with (cloudflare.config.ts, Nish
  // 2026-10-01): private until drive has its own domain, the workers.dev
  // address on only behind Cloudflare Access ("All traffic", Cloudflare
  // account members), and no preview URLs. Nothing here opens a public
  // address the site Worker does not already hold.
  workersDev: true,
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
    // core/device-signin.js) and well above the sign-in binding's
    // 10 a minute, which would lock a polling CLI out of the flow it is in.
    // It stays far below what a script needs to walk short user codes.
    //
    // The global one bounds the token factory: both a poll (which mints a
    // device token) and an approval (which attaches a signed-in account) are
    // public, so the ceiling is a spend bound on the worst case whatever many
    // IPs it comes from, and it sits far above the per-IP world it caps.
    //
    // Each binding needs its own namespace: Cloudflare wants a positive
    // integer string unique per account, and a namespace another binding
    // already uses fails the deploy with 10021. The site Worker holds 1001
    // (waitlist), 1002/1003 (sign-in), 1004/1005 (request-upload) and 1008
    // (share download), so the api Worker's pair is 1006/1007. Both configs
    // are one minute, the waitlist's period, so one number describes every
    // rate limit on this account.
    DEVICE_RATE_LIMITER: bindings.rateLimit({
      namespace: "1006",
      simple: { limit: 60, period: 60 },
    }),
    DEVICE_GLOBAL_RATE_LIMITER: bindings.rateLimit({
      namespace: "1007",
      simple: { limit: 600, period: 60 },
    }),
    // drive#462: the iDrive e2 reseller API token, the credential that mints
    // a key limited to ONE bucket. iDrive e2 cannot scope a key to a folder
    // and its STS refuses `AssumeRole` outright (measured 2026-10-03,
    // drive#173), so on the primary vendor the only way to hand out a
    // per-account key is the reseller API's `create_access_key` — which is
    // what `keyProviderFor` picks when this value is set and no `STORAGE_*`
    // is (workers/api/src/index.js). With it, the boundary a key carries is
    // the account's own bucket (`drv-<id>`, `drv-t-<teamId>`,
    // keyprovider.js `bucketForAccount` / `bucketForTeam`), so the storage
    // server itself refuses one account's key against another's files.
    //
    // Declared so the runtime injects it and the name cannot drift from the
    // code that reads it; a missing value is a warning at dev/deploy and
    // `keyProviderFor` answers null, which is the closed door
    // ("storage is not configured on this deployment"), not a mint against
    // something the vendor never approved. The token itself is never a value
    // in this file and is never logged. Set it once, beside the two above
    // (it persists across deploys):
    //   cf workers secrets update IDRIVE_E2_API_TOKEN --type secret_text \
    //     --text <token> --worker drive-api
    // (--type is required: cf refuses the update without it.)
    IDRIVE_E2_API_TOKEN: bindings.secret(),
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
    // when a deployment leaves them unset. The same is true of the iDrive e2
    // side: the reseller token above is the only one of the storage
    // credentials declared as a binding, because it is the only one whose
    // absence must be visible in the deploy rather than in a route's answer —
    // the STORAGE_* values are a per-deployment choice (stand-in, B2) and
    // declaring any one of them would refuse the deploy for a deployment that
    // chose the other.
  },
});
