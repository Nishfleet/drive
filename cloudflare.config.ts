import { bindings, defineConfig, triggers } from "cf/config";
import * as entrypoint from "./src/index.js" with { type: "cf-worker" };
import { METER_CRON } from "./src/meter.js";

// drive issue #11: the pricing and landing page, served as Worker static
// assets, with /api/* routed to the Worker for the waitlist form and the
// meter's event intake.
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
		// The meter's hourly rollup (drive issue #6). One trigger, and the
		// schedule string is the one the meter module exports, pinned by
		// test/meter.test.mjs the way the static pages are pinned to their copy.
		triggers: [triggers.scheduled({ schedule: METER_CRON })],
		env: {
			ASSETS: bindings.assets(),
			WAITLIST_DB: bindings.d1({
				name: "drive-waitlist",
				id: "93c9f523-159c-4261-8541-d4c059906df3",
			}),
			// The meter reads and writes the api Worker's own tables, so it
			// binds the same database under a name of its own: the meter's code
			// says which tables it owns, and when those tables move to their own
			// database the binding is the only line that changes.
			METER_DB: bindings.d1({
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
		},
	},
});
