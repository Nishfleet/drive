import { bindings, defineConfig, triggers } from "cf/config";
import * as entrypoint from "./src/index.js" with { type: "cf-worker" };

// drive issue #11: the pricing and landing page, served as Worker static
// assets, with /api/* routed to the Worker for the waitlist form.
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
		// drive issue #18: the file index's nightly reconciler. `scheduled` in
		// src/index.js rebuilds one account's rows from a full store walk; the
		// schedule is the only way a rebuild starts, so no web request can spend
		// the walk (the safety review: reindex is not a public route). 03:00 UTC
		// is the spec's quiet hour, before the meter's first hourly run.
		triggers: [triggers.scheduled({ schedule: "0 3 * * *" })],
		env: {
			ASSETS: bindings.assets(),
			WAITLIST_DB: bindings.d1({
				name: "drive-waitlist",
				id: "93c9f523-159c-4261-8541-d4c059906df3",
			}),
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
			// store's per-address CODE_SEND_LIMIT. The store's limit lives in the
			// isolate's own memory and keys on one address, so a script walking
			// many addresses is invisible to it; these two bindings are the edge
			// bound the issue asks for. The per-IP one is far above a person
			// signing in (even behind a shared office NAT) and far below what a
			// script needs to walk addresses; the global one bounds the whole
			// service. Both configs are one minute, the waitlist's period, and
			// both are turned on before sign-in opens in production.
			//
			// The global ceiling is a spend bound, not a traffic shaper: it sits
			// far above any plausible sign-in demand, so it never shapes a real
			// person's sign-in, and it caps the worst case at 100 sends a minute
			// however many addresses a distributed walk touches. Revisit the
			// number the day sign-in opens (issue #147).
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
