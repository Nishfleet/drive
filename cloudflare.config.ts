import { bindings, defineConfig } from "cf/config";
import * as entrypoint from "./src/index.js" with { type: "cf-worker" };

// drive issue #11: the pricing and landing page, served as Worker static
// assets, with /api/* routed to the Worker for the waitlist form.
export default defineConfig({
	worker: {
		name: "drive-pricing",
		compatibilityDate: "2026-09-29",
		entrypoint,
		// Everything that is not /api/* is served straight from the asset
		// layer, so the page never pays for a Worker invocation. /api/* runs the
		// Worker; the Worker's own fallthrough to ASSETS.fetch keeps a stray
		// path an asset 404 instead of a hand-rolled error page.
		assets: {
			runWorkerFirst: ["/api/*"],
			notFoundHandling: "404-page",
		},
		env: {
			ASSETS: bindings.assets(),
			WAITLIST_DB: bindings.d1({
				name: "drive-waitlist",
				id: "93c9f523-159c-4261-8541-d4c059906df3",
			}),
			// drive issue #28: bound the waitlist endpoint. Five sign-ups a
			// minute per client IP is far above a person's pace and far below
			// what a script needs to enumerate addresses or fill the table.
			WAITLIST_RATE_LIMITER: bindings.rateLimit({
				namespace: "drive-waitlist",
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
			// before drive has one. Set at deploy time:
			//   npx wrangler secret put EMAIL_SEND_TOKEN
			//   npx wrangler secret put MAIL_FROM
			EMAIL_SEND_TOKEN: bindings.secret(),
			MAIL_FROM: bindings.secret(),
			// The `rclone serve s3` stand-in (drive issue #1's build host):
			// with both set, storeFor() in src/index.js points the file
			// handlers at the stand-in instead of the in-memory store. They
			// default to "", so a production deploy that sets neither gets
			// the in-memory store exactly as before — a declared var with an
			// empty default is the config way to say "set it if you run the
			// stand-in", and the empty string is the falsy value storeFor()
			// already branches on.
			FILES_S3_ENDPOINT: bindings.text(""),
			FILES_S3_BUCKET: bindings.text(""),
		},
	},
});
