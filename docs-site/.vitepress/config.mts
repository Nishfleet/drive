// The docs site (drive issue #98). The tool is VitePress, with the
// vitepress-plugin-llms plugin for the agent-facing files.
//
// Why VitePress over the other two: this repository is already a Vite project
// (vite 8, @cloudflare/vite-plugin), and VitePress is the docs tool in the same
// stable; Starlight would add a second framework (Astro) and its own build
// pipeline next to Vite, and mdBook is a Rust binary with no llms.txt story at
// all. The plugin writes llms.txt, llms-full.txt and a Markdown copy of every
// page, which is exactly what the issue asks for, and it is the plugin Vite,
// Vue and Vitest themselves use.
//
// Prices are not written in the pages: the pages carry {{MARKER}}s and
// src/render-docs.js fills them from src/billing.js before this build runs, so
// test/docs.test.mjs can fail the build when the two disagree.
import { defineConfig } from "vitepress";
import llmstxt from "vitepress-plugin-llms";

// The one site address (drive#527). site.json holds it, so a domain move is
// one edit and the CLI reads the same file (cmd/drive/login.go embeds it).
import site from "../../cmd/drive/site.json" with { type: "json" };

const SITE_ORIGIN = site.origin as string;

export default defineConfig({
  // The rendered pages: authored Markdown with {{MARKER}}s lives in the parent
  // directory, and src/render-docs.js writes the substituted copies here.
  srcDir: ".rendered",
  // Served from the Worker's static assets, next to the pricing page, so the
  // docs ship as files and never as a route the Worker has to render.
  outDir: "../public/docs",
  base: "/docs/",
  // One canonical address per page, so /docs/quickstart is the page and
  // /docs/quickstart.html is not a second one.
  cleanUrls: true,
  // The llms plugin writes llms.txt and llms-full.txt into the docs outDir,
  // so both sit under /docs/ and both resolve (drive#527). Nothing is exempt
  // any more, so the check stays on for every real page.
  ignoreDeadLinks: [`${SITE_ORIGIN}/`],
  title: "Drive docs",
  description:
    "A Finder drive for people and their agents: plain files in object storage, mounted with stock rclone, billed at 2¢ per GB-month for the biggest size in the last 30 days.",
  lang: "en",
  // The rest of the site is light-only. A docs appearance toggle would be a
  // second look, and the inline dark-mode check shifts the first paint.
  appearance: false,
  // The pricing page is the canonical entry point; the docs are the reference
  // behind it. Cross-linking keeps the two reading as one product.
  head: [
    ["link", { rel: "icon", href: "/favicon.svg", type: "image/svg+xml" }],
    [
      "link",
      { rel: "alternate", type: "text/markdown", href: `${SITE_ORIGIN}/docs/llms-full.txt` },
    ],
    [
      "link",
      {
        rel: "preload",
        href: "/fonts/big-shoulders-display-latin-900-normal.woff2",
        as: "font",
        type: "font/woff2",
        crossorigin: "",
      },
    ],
  ],
  // A wide table must scroll inside its own box at 375px instead of widening
  // the page (drive#546). VitePress's own table_open rule gives the table
  // tabindex="0"; chain it and wrap the table in the scroll container. The
  // table keeps display: table (theme/site.css) so its cells stay aligned.
  markdown: {
    config(md) {
      const open = md.renderer.rules.table_open;
      const close = md.renderer.rules.table_close;
      md.renderer.rules.table_open = (tokens, idx, options, env, self) =>
        `<div class="table-wrap">${open ? open(tokens, idx, options, env, self) : self.renderToken(tokens, idx, options)}`;
      md.renderer.rules.table_close = (tokens, idx, options, env, self) =>
        `${close ? close(tokens, idx, options, env, self) : self.renderToken(tokens, idx, options)}</div>`;
    },
  },
  themeConfig: {
    nav: [
      { text: "Pricing", link: `${SITE_ORIGIN}/` },
      { text: "Docs", link: "/" },
      { text: "Get started", link: `${SITE_ORIGIN}/get-started` },
      { text: "Sign in", link: `${SITE_ORIGIN}/signin` },
    ],
    sidebar: [
      { text: "Quickstart", link: "/quickstart" },
      { text: "How it works", link: "/how-it-works" },
      { text: "Agents", link: "/agents" },
      { text: "Pricing and your bill", link: "/pricing" },
      { text: "FAQ", link: "/faq" },
      { text: "When something goes wrong", link: "/troubleshooting" },
      { text: "Limits", link: "/limits" },
      { text: "Benchmarks", link: "/benchmarks" },
      { text: "Security", link: "/security" },
      { text: "Changelog", link: "/changelog" },
    ],
    // The llms plugin's own settings: the origin makes every link absolute, so
    // an agent reading llms.txt from a cache still resolves the page.
    llms: {
      domain: SITE_ORIGIN,
    },
    footer: {
      message: "Drive is not open yet — sign-ups go to a waitlist on the pricing page.",
    },
  },
  vite: {
    plugins: [
      llmstxt({
        domain: SITE_ORIGIN,
        // The docs home is a table of contents, so it gets no .md copy; every
        // page that must be reachable as .md is a real page.
        excludeIndexPage: true,
      }),
    ],
  },
  // VitePress's default theme preloads Inter. The docs use the site's faces,
  // and that extra preload was a 0.015 layout shift (drive#458, budget 0.01).
  transformHtml(code) {
    return code.replace(
      /<link rel="preload" href="\/docs\/assets\/inter-[^"]*" as="font"[^>]*>/g,
      "",
    );
  },
});
