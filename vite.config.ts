import { cloudflare } from "@cloudflare/vite-plugin";
import { defineConfig, type Plugin } from "vite";
import { FIRST_RUN_STEPS, INSTALL_COMMAND } from "./src/status.js";

export default defineConfig({
  plugins: [cloudflare(), staticFirstRunShell()],
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
