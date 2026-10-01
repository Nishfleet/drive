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

const SITE_ORIGIN = "https://drive-pricing.nishant345.workers.dev";

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
  // Two links leave the docs on purpose: the agent-facing files sit at the
  // site root next to the pricing page, not under /docs/. Nothing else may be
  // dead, so the check stays on for every real page.
  ignoreDeadLinks: [
    "/llms.txt",
    "/llms-full.txt",
    `${SITE_ORIGIN}/`,
  ],
  title: "Drive docs",
  description:
    "A Finder drive for people and their agents: plain files in object storage, mounted with stock rclone, billed at 2¢ per GB-month by the minute.",
  lang: "en",
  // The pricing page is the canonical entry point; the docs are the reference
  // behind it. Cross-linking keeps the two reading as one product.
  head: [
    [
      "link",
      { rel: "alternate", type: "text/markdown", href: `${SITE_ORIGIN}/llms-full.txt` },
    ],
  ],
  themeConfig: {
    nav: [
      { text: "Pricing", link: `${SITE_ORIGIN}/` },
      { text: "Docs", link: "/" },
    ],
    sidebar: [
      { text: "Quickstart", link: "/quickstart" },
      { text: "How it works", link: "/how-it-works" },
      { text: "Agents", link: "/agents" },
      { text: "Pricing and your bill", link: "/pricing" },
      { text: "FAQ", link: "/faq" },
      { text: "Limits", link: "/limits" },
      { text: "Security", link: "/security" },
      { text: "Changelog", link: "/changelog" },
    ],
    // The llms plugin's own settings: the origin makes every link absolute, so
    // an agent reading llms.txt from a cache still resolves the page.
    llms: {
      domain: SITE_ORIGIN,
    },
    footer: {
      message:
        "Drive is not open yet — sign-ups go to a waitlist on the pricing page.",
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
});
