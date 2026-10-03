import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cloudflare } from "@cloudflare/vite-plugin";
import { defineConfig, type Plugin } from "vite";
import {
  assertSingleBeacon,
  BEACON_PAGES,
  BEACON_TOKEN_SETTING,
  beaconToken,
  withBeacon,
} from "./src/analytics.js";
import { FIRST_RUN_STEPS, INSTALL_COMMAND } from "./src/status.js";
import apiWorker from "./workers/api/cloudflare.config.ts";

export default defineConfig({
  plugins: [
    cloudflare({
      auxiliaryWorkers: [
        // The api Worker (drive issue #168). Its deploy config is
        // workers/api/cloudflare.config.ts, which the CLI's autoconfig never
        // reaches (CONFIG_FILENAME is resolved against the Vite root, and the
        // root's file is the site Worker's), so it is registered here as an
        // auxiliary Worker: the stock way a second Worker joins the build
        // output, and what makes the file a deploy config rather than dead
        // text. The build emits it beside the site Worker in the Build
        // Output, and a `cf deploy --worker drive-api` step ships it.
        { config: apiWorker },
      ],
    }),
    staticFirstRunShell(),
    webAnalyticsBeacon(),
  ],
  environments: {
    client: {
      build: {
        rollupOptions: {
          input: {
            // The first-run page is a built entry (drive issue #70): its
            // <script type="module"> is bundled from src/get-started.js,
            // which imports the copy from src/status.js. Vite only treats an
            // HTML file as an entry when it is named here (index.html is the
            // implicit default), and the output keeps the entry's own file
            // name, so the page ships at /get-started.html as before. The
            // input is scoped to the client environment: the Worker build's
            // entry stays the src/index.js named in cloudflare.config.ts.
            "get-started": "./get-started.html",
          },
        },
      },
    },
  },
});

/**
 * The Cloudflare Web Analytics beacon, in the six pages drive#246 names, and
 * only when a beacon token is configured (drive issue #246).
 *
 * The pages ship as static assets: five are copied out of public/ verbatim and
 * one is the built Vite entry, and only the built entry reaches
 * `transformIndexHtml`. So the beacon is injected where both land, which is the
 * client environment's output directory, in `writeBundle` (after Vite has
 * written the files and before the Cloudflare plugin collects them as the
 * Worker's assets). That directory is taken from the client environment's own
 * resolved config, where `build.outDir` is already absolute: this repo's output
 * is `.cloudflare/output/...` inside the root, and joining the root onto the
 * resolved path walks it a second time. The six pages are the site's most-read
 * documents, served straight from the asset layer so that no page view costs a
 * Worker invocation (cloudflare.config.ts), and a request-time rewrite to add an
 * analytics script would spend one.
 *
 * The token comes from the environment, and an unset setting is the
 * switched-off case: the tag is not written at all, so the pages are byte for
 * byte what they ship today. Set it to the dashboard's 32-hex token to measure:
 *
 *   DRIVE_CF_BEACON_TOKEN=<32 hex> npm run build
 *
 * and in a deploy, a GitHub Actions variable of that name on the build step
 * (it is a variable, not a secret: the token is in every page's HTML).
 * src/analytics.js holds the token's shape and the tag, so both are unit
 * tested, and test/web-analytics.test.mjs fails if this plugin is dropped.
 * @returns {Plugin}
 */
function webAnalyticsBeacon(): Plugin {
  // The client environment's output directory, taken from the environment this
  // plugin is applied to rather than from the top-level config, which is the
  // Worker build's. Vite has already resolved it to an absolute path here.
  let assetsDir = "";
  return {
    name: "drive-web-analytics-beacon",
    applyToEnvironment(environment) {
      if (environment.name !== "client") return false;
      assetsDir = environment.config.build.outDir;
      return true;
    },
    writeBundle() {
      // An empty directory would make every readFileSync below throw ENOENT with a
      // path that says nothing about why it is wrong, so it is named here.
      if (assetsDir === "") {
        throw new Error("drive-web-analytics-beacon found no client build output directory");
      }
      // Read once, before the loop: a mis-set token fails the build before any
      // file is touched, so a failed build leaves no half-instrumented output.
      const token = beaconToken(process.env[BEACON_TOKEN_SETTING]);
      if (token === "") return;
      for (const page of BEACON_PAGES) {
        const file = join(assetsDir, page);
        const html = readFileSync(file, "utf8");
        const withTag = withBeacon(html, token);
        if (withTag !== html) writeFileSync(file, withTag);
        // The gate on the bytes as written, not on the bytes as computed: the
        // file on disk is what ships, so the file on disk is what is checked.
        assertSingleBeacon(readFileSync(file, "utf8"), page);
      }
    },
  };
}

/**
 * The walk-through and the one command, printed into the built
 * get-started.html (drive#225). The page shipped its <ol id="steps"> and its
 * <code id="install-command"> empty and let the module fill them in, so the
 * first paint had a blank list: the page was not usable until the script ran,
 * and when the script filled the list the page jumped (a 0.23 CLS on the
 * Lighthouse run measured 2026-10-02). The words are src/status.js's, so the
 * HTML carrying them statically is a build step and not a third copy to drift:
 * this runs in the same build that already reads that module for the module
 * script, and throws when a marker it replaces is not in the page, so a page
 * that moved under it fails the build rather than shipping an empty list again.
 * @returns {Plugin}
 */
function staticFirstRunShell(): Plugin {
  /** @param {string} text @returns {string} */
  const text = (value) =>
    value.replace(/[&<>]/g, (c) => `&${{ "&": "amp", "<": "lt", ">": "gt" }[c]};`);
  return {
    name: "drive-static-first-run-shell",
    transformIndexHtml: {
      order: "pre",
      handler(html) {
        const steps = FIRST_RUN_STEPS.map(
          (step) => `        <li><h3>${text(step.title)}</h3><p>${text(step.body)}</p></li>`,
        ).join("\n");
        const withSteps = html.replace(
          '      <ol class="steps" id="steps">\n        <!-- Filled by get-started.js from src/status.js -->\n      </ol>',
          `      <ol class="steps" id="steps">\n${steps}\n      </ol>`,
        );
        const withCommand = withSteps.replace(
          '<code id="install-command"></code>',
          `<code id="install-command">${text(INSTALL_COMMAND)}</code>`,
        );
        if (withSteps === html || withCommand === withSteps) {
          throw new Error(
            "get-started.html moved: the static first-run shell found neither its steps list nor its command",
          );
        }
        return withCommand;
      },
    },
  };
}
