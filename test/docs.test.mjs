// The docs site (drive issue #98): every page reachable, every number the
// invoice's own, and the agent-facing index complete. The docs are a generated
// section of the site, so the gate is the same one the shipped pricing page
// uses: the tests build their expectations from src/billing.js and fail CI
// when a page drifts from it.

import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { test } from "node:test";
import {
  BILLING_CONFIG,
  GB_PER_TB,
  MINUTES_PER_MONTH,
  meteredMonthlyBillUsd,
  monthBillCents,
  monthlyCeilingUsd,
} from "../src/billing.js";
import { FAQ, faqMarkdown, RIVAL_1TB_LINE, scoreboardVerdict } from "../src/docs.js";
import { AGENT_TOOLS, KEY_POWERS } from "../src/keys.js";
import { applyMarkers, DOC_PAGES, renderDocs } from "../src/render-docs.js";
import { SITE } from "../src/seo.js";
import { INSTALL_COMMAND } from "../src/status.js";

// The head-to-head table the FAQ is gated against (drive issue #114).
// The tests below read it twice: once to prove every published answer
// rests on a measured win, and once to prove the render refuses an
// answer whose row has lost its measurement.
const scoreboard = readFileSync(new URL("../docs/scoreboard.md", import.meta.url), "utf8");

// The built site, which `npm test` produces before the suite runs
// (package.json: test = typecheck + docs:build + node --test). These tests
// read what would ship, not the authored Markdown, so a page that renders but
// ships a wrong number fails here.
const siteDir = new URL("../public/docs/", import.meta.url);
/** @param {string} name */
const shipped = (name) => readFileSync(new URL(name, siteDir), "utf8");

// The price numbers, worked out the way the invoice works them out: a month
// that stored `tb` terabytes all month is gb x 43,800 GB-minutes and a peak of
// the same gb. Nothing in these tests types a dollar figure.
/** @param {number} tb */
function billFor(tb) {
  const gb = tb * GB_PER_TB;
  return monthBillCents({ gbMinutes: gb * MINUTES_PER_MONTH, peakGb: gb });
}

/** @param {number} amount */
const dollars = (amount) => (Number.isInteger(amount) ? `$${amount}` : `$${amount.toFixed(2)}`);

test("every docs page exists, is registered, and ships as HTML and .md", () => {
  for (const page of DOC_PAGES) {
    assert.ok(existsSync(new URL(page.file, siteDir)), `${page.file} was not built`);
    assert.ok(
      existsSync(new URL(`${page.file.replace(/\.md$/, ".html")}`, siteDir)),
      `${page.url} must ship an HTML page`,
    );
    // The agent-facing copy of the same page, next to the HTML, so an answer
    // engine reads the same words a person does.
    assert.ok(
      shipped(page.file).includes(`# ${page.title}`),
      `${page.url}.md must hold the ${page.title} page`,
    );
  }
});

test("a page that ships is a page the index knows about, and the other way round", () => {
  const built = readdirSync(siteDir)
    .filter((name) => name.endsWith(".md"))
    .sort();
  assert.deepEqual(
    built,
    DOC_PAGES.map((page) => page.file).sort(),
    "a page must be listed in DOC_PAGES, so the sitemap, the llms index and the test all know about it",
  );
});

test("no marker survives rendering, and no marker is left without a page", () => {
  for (const page of DOC_PAGES) {
    const leftover = shipped(page.file).match(/\{\{[A-Z_]+\}\}/g) || [];
    assert.deepEqual(
      leftover,
      [],
      `${page.file} still carries unresolved markers: ${leftover.join(", ")}`,
    );
  }
  // A value the docs compute and no page states is drift in the other
  // direction: a page that lost its marker, or a figure nobody tells a reader.
  assert.doesNotThrow(() => renderDocs(), "the render must find every marker used");
});

test("a page may not use a marker src/docs.js does not define", () => {
  assert.throws(
    () => applyMarkers("{{NOT_A_MARKER}}"),
    /NOT_A_MARKER/,
    "an unknown marker must fail the render, not ship as a literal",
  );
});

test("the pricing page carries the invoice's numbers, not typed ones", () => {
  const page = shipped("pricing.md");
  // The rate, both halves of the ceiling, the free credit and the cap, each
  // read from the one config the invoice reads.
  assert.ok(page.includes("2¢ per GB"), "the pricing page must state the rate");
  assert.ok(
    page.includes(dollars(BILLING_CONFIG.floorUsd)),
    "the pricing page must state the ceiling floor",
  );
  assert.ok(
    page.includes(dollars(BILLING_CONFIG.perTbUsd)),
    "the pricing page must state the per-TB ceiling",
  );
  assert.ok(
    page.includes(dollars(BILLING_CONFIG.freeMonthlyUsd)),
    "the pricing page must state the free credit",
  );
  assert.ok(
    page.includes(dollars(BILLING_CONFIG.defaultCapUsd)),
    "the pricing page must state the default cap",
  );
});

test("every worked example on the pricing page is the invoice's own arithmetic", () => {
  const page = shipped("pricing.md");
  for (const tb of [0.8, 1.3, 2, 5]) {
    const gb = tb * GB_PER_TB;
    const bill = billFor(tb);
    const row = `| ${tb} TB | ${dollars(meteredMonthlyBillUsd(gb * MINUTES_PER_MONTH))} | ${dollars(monthlyCeilingUsd(gb))} | ${dollars(bill.totalCents / 100)} |`;
    assert.ok(page.includes(row), `the pricing page must show the row: ${row}`);
  }
  // And the metered column is genuinely larger than the bill at the sizes the
  // ceiling exists for, so the page cannot quietly drop the ceiling.
  assert.ok(
    meteredMonthlyBillUsd(2 * GB_PER_TB * MINUTES_PER_MONTH) > billFor(2).totalCents / 100,
    "2 TB metered must be more than 2 TB billed, or the ceiling is not being applied",
  );
});

test("the docs never promise what the money module does not compute", () => {
  for (const page of DOC_PAGES) {
    const md = shipped(page.file);
    // The spec's bans (docs/build-spec.md "Never do"): no unlimited, no
    // credit units, no per-minute price.
    assert.doesNotMatch(md, /unlimited/i, `${page.file} must not claim unlimited storage`);
    assert.doesNotMatch(md, /\bcredits?\b/i, `${page.file} must not sell the free $1 as credits`);
    assert.doesNotMatch(
      md,
      /\$\s?[\d.,]+\s*(\/|per\s)min/i,
      `${page.file} must not advertise a per-minute price`,
    );
  }
});

test("the agents page names the tools the CLI connects and their real powers", () => {
  const page = shipped("agents.md");
  for (const tool of AGENT_TOOLS) {
    assert.ok(page.includes(tool), `the agents page must name the ${tool} tool`);
  }
  // The key table is read from workers/api/src/keyprovider.js, so the page
  // cannot claim a power the api Worker does not grant.
  assert.equal(KEY_POWERS.device.canDelete, true);
  assert.equal(KEY_POWERS.agent.canDelete, false);
  assert.ok(
    page.includes("An agent key cannot delete a file."),
    "the agents page must say an agent key cannot delete",
  );
  assert.ok(
    page.includes(INSTALL_COMMAND),
    `the agents page must name the one command (${INSTALL_COMMAND})`,
  );
});

test("the security page states the same key table, and what we cannot claim", () => {
  const page = shipped("security.md");
  assert.ok(page.includes("An agent key cannot delete a file."));
  assert.ok(
    page.includes(dollars(BILLING_CONFIG.defaultCapUsd)),
    "the security page must state the default cap",
  );
  // A security page that only lists what is good is not useful, so the
  // unencrypted-storage truth has to be on it.
  assert.match(
    page,
    /no end-to-end encryption/i,
    "the security page must say version 1 is not end-to-end encrypted",
  );
  assert.doesNotMatch(page, /SOC 2/i, "the security page must not claim a certification");
});

test("the limits page is honest: not open, no install script, and the CLI gaps named", () => {
  const page = shipped("limits.md");
  assert.match(page, /not open yet/i, "the limits page must say the drive is not open");
  assert.match(
    page,
    /go install github\.com\/Nishfleet\/drive\/cmd\/drive/,
    "the limits page must give the install that works today",
  );
  assert.match(
    page,
    /slower than the alternatives/i,
    "the limits page must say where we lose to rivals",
  );
  // Commands the CLI does not have (cmd/drive/main.go's switch) must be on the
  // page as "not in the CLI", never shown as working. A test cannot read the Go
  // switch, so this pins the two that the docs otherwise lean on.
  for (const missing of ["restore", "branch"]) {
    assert.match(
      page,
      new RegExp(`No \`${missing}\` command yet|No branch or approve commands`),
      `the limits page must say there is no ${missing} command yet`,
    );
  }
});

test("the changelog opens today and every entry is a real line", () => {
  const page = shipped("changelog.md");
  assert.match(page, /## \d{4}-\d{2}-\d{2}/, "the changelog must open with a date heading");
  assert.ok(
    page.includes(dollars(BILLING_CONFIG.perTbUsd)),
    "the changelog must state the ceiling it recorded",
  );
});

test("every FAQ answer rests on a scoreboard row that is a measured win", () => {
  // The orchestrator's rule (issue #98, comment 2026-09-30): a line
  // whose row is still "not yet measured" stays out of the published
  // FAQ. src/docs.js declares which row each answer rests on, so the
  // gate reads the real table: an answer that loses its measurement
  // fails here instead of shipping an unmeasured claim.
  for (const entry of FAQ) {
    for (const metric of entry.scoreboard) {
      assert.equal(
        scoreboardVerdict(scoreboard, metric),
        "win",
        `${entry.question} rests on "${metric}", which the scoreboard does not mark as a measured win`,
      );
    }
  }
});

test("the render refuses an FAQ answer whose row is not yet measured", () => {
  // The same gate, turned around: take a row the FAQ answers rest on
  // and read it the way the scoreboard reads it before a measurement
  // lands. faqMarkdown() must refuse, naming the answer and the row,
  // so the answer leaves the page at the next build rather than
  // staying up unmeasured.
  /** @param {string} metric @param {string} verdict */
  const flip = (metric, verdict) =>
    scoreboard
      .split("\n")
      .map((line) =>
        line.startsWith(`| ${metric} |`) ? line.replace("| win |", `| ${verdict} |`) : line,
      )
      .join("\n");
  assert.throws(
    () => faqMarkdown(flip("price at 1 TB", "not yet measured")),
    /price at 1 TB/,
    "the cost answer must come out when its row is not yet measured",
  );
  assert.throws(
    () => faqMarkdown(flip("agent features: no-delete keys", "not yet measured")),
    /no-delete keys/,
    "the agents answer must come out when one of its rows is not yet measured",
  );
});

test("the shipped FAQ is exactly the answers the data publishes", () => {
  const faq = shipped("faq.md");
  const headings = [...faq.matchAll(/^## (.+)$/gm)].map((match) => match[1]);
  assert.deepEqual(
    headings,
    FAQ.map((entry) => entry.question),
    "the FAQ page must carry every answer src/docs.js publishes, and no hand-added ones",
  );
  for (const entry of FAQ) {
    assert.ok(faq.includes(`## ${entry.question}`), `the FAQ must answer "${entry.question}"`);
  }
});

test("the FAQ's rival line keeps the orchestrator's phrasing, from the scoreboard's row", () => {
  const faq = shipped("faq.md");
  // "Space price line: say '$20 a month, or $15 paid yearly'" — the
  // phrasing is fixed, and both figures must still be the ones the
  // scoreboard's price-at-1-TB row records for Space, so the line
  // cannot drift from the row it came from.
  assert.ok(faq.includes(RIVAL_1TB_LINE), "the FAQ must carry the rival line built in src/docs.js");
  assert.ok(
    faq.includes("Space charges $20 a month, or $15 paid yearly, for 1 TB."),
    "the rival line must keep the orchestrator's exact phrasing",
  );
  const row = scoreboard.split("\n").find((line) => line.startsWith("| price at 1 TB |"));
  assert.ok(row);
  const figures = [...row.matchAll(/\$(\d+)/g)].map((match) => match[1]);
  for (const figure of ["20", "15"]) {
    assert.ok(
      figures.includes(figure),
      `the scoreboard's price at 1 TB row must still record $${figure} for Space`,
    );
  }
});

test("no [verify] line ships in any docs page", () => {
  // A [verify] marker is the draft's own sign that a line is waiting
  // on a measurement. One surviving into the built site means the
  // line shipped before its row was measured, which is the failure
  // the FAQ rule exists to prevent.
  for (const page of DOC_PAGES) {
    assert.doesNotMatch(
      shipped(page.file),
      /\[verify/i,
      `${page.file} ships a [verify] line, so an unmeasured claim reached the site`,
    );
  }
});

test("llms.txt links every page, and llms-full.txt holds all of them", () => {
  const llms = shipped("llms.txt");
  const full = shipped("llms-full.txt");
  for (const page of DOC_PAGES) {
    // The docs home is the heading, and every page is a link with its
    // description, so an agent can pick a page without fetching them all.
    assert.ok(llms.includes(`${SITE.origin}${page.url}.md`), `llms.txt must link ${page.url}.md`);
    assert.ok(llms.includes(page.file.slice(0, -3)), `llms.txt must name the ${page.title} page`);
    assert.ok(full.includes(`# ${page.title}`), `llms-full.txt must hold the ${page.title} page`);
  }
});

test("the sitemap lists the docs pages on the canonical origin, in order", () => {
  const sitemap = readFileSync(new URL("../public/sitemap.xml", import.meta.url), "utf8");
  const locations = [...sitemap.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);
  assert.deepEqual(
    locations,
    [SITE.homePath, ...DOC_PAGES.map((page) => page.url)].map((path) => `${SITE.origin}${path}`),
    "the sitemap must list the home page and every docs page, in order",
  );
  // A docs URL in the sitemap that nothing serves is the drift the issue names:
  // a page that exists on disk and is not in the sitemap, or the reverse.
  for (const page of DOC_PAGES) {
    assert.ok(
      existsSync(new URL(`${page.url.replace(/^\/docs\//, "")}.html`, siteDir)),
      `${page.url} is in the sitemap, so it must ship an HTML page`,
    );
  }
});

test("every shell sample in the docs is a command the CLI actually has", () => {
  // The orchestrator's second-pass note (issue #98, comment 1) asks for every
  // code sample to be run in CI, the way Space checks its 84 samples. There is
  // no stock doc-test route for this corpus: `mdbook test` runs Rust in fenced
  // blocks, `sphinx.ext.doctest` runs Python `>>>` sessions, and VitePress,
  // Starlight and Docusaurus ship no runner at all (searched the three tools'
  // own docs plus mdBook's, on 2026-09-30). The samples here are shell commands
  // that mount storage and connect agent tools, which a CI runner cannot do, so
  // the mechanical substitute is this: every `drive ...` sample is checked
  // against the subcommand switch in cmd/drive/main.go, and the one sample that
  // is not a `drive` command is pinned by name. A renamed or removed
  // subcommand fails the build instead of shipping a sample that does nothing.
  const mainGo = readFileSync(new URL("../cmd/drive/main.go", import.meta.url), "utf8");
  const switchBody = mainGo.slice(mainGo.indexOf("switch os.Args[1]"), mainGo.indexOf("default:"));
  const subcommands = new Set([...switchBody.matchAll(/case "([a-z]+)"/g)].map((m) => m[1]));
  assert.ok(
    subcommands.has("mount") && subcommands.has("init"),
    "the subcommand list must have been parsed out of main.go",
  );

  // The commands a page may show, outside `drive <sub>`. Each is a stock tool
  // invocation the page explains in prose; adding one is a deliberate edit.
  const nonDriveSamples = new Set([
    "go install github.com/Nishfleet/drive/cmd/drive@latest",
    "export DRIVE_S3_ENDPOINT=https://your-endpoint",
    "export DRIVE_S3_BUCKET=your-bucket",
    "export DRIVE_S3_PREFIX=your-folder",
    "export DRIVE_S3_ACCESS_KEY_ID=...",
    "export DRIVE_S3_SECRET_ACCESS_KEY=...",
  ]);

  let samples = 0;
  for (const page of DOC_PAGES) {
    const md = shipped(page.file);
    for (const block of md.matchAll(/```(?:sh|bash)\n([\s\S]*?)```/g)) {
      for (const raw of block[1].split("\n")) {
        const line = raw.trim();
        if (line === "") continue;
        samples += 1;
        const match = line.match(/^drive ([a-z]+)/);
        if (match) {
          assert.ok(
            subcommands.has(match[1]),
            `${page.file} shows \`${line}\`, and \`drive ${match[1]}\` is not in cmd/drive/main.go`,
          );
          continue;
        }
        assert.ok(
          nonDriveSamples.has(line),
          `${page.file} shows an unchecked sample \`${line}\`; add it to nonDriveSamples with the reason it cannot be run here`,
        );
      }
    }
  }
  assert.ok(samples >= 5, `the docs must carry the samples (found ${samples})`);
});

test("the docs config and the site's own config agree on the origin", () => {
  // The VitePress config cannot import src/seo.js (it is outside the docs
  // project, and VitePress's Vite will not load from there), so it repeats the
  // origin. This is the gate that keeps the repeat honest: a base or an origin
  // edited in one place fails here rather than shipping a docs site on a
  // different host from the pricing page.
  const config = readFileSync(
    new URL("../docs-site/.vitepress/config.mts", import.meta.url),
    "utf8",
  );
  assert.match(
    config,
    new RegExp(`const SITE_ORIGIN = "${SITE.origin}";`),
    "the docs config must use the canonical origin from src/seo.js",
  );
  assert.match(
    config,
    /base: "\/docs\/"/,
    "the docs must be served from /docs/, beside the pricing page",
  );
  // And the two llms files the pages link are the ones that ship.
  const home = shipped("index.html");
  assert.ok(
    home.includes("/docs/llms-full.txt"),
    "the docs home must link the llms-full.txt that the build writes",
  );
  const rootLlms = readFileSync(new URL("../public/llms.txt", import.meta.url), "utf8");
  assert.ok(
    rootLlms.includes(`${SITE.origin}/docs/llms-full.txt`),
    "the site llms.txt must link the llms-full.txt that the build writes",
  );
  for (const page of DOC_PAGES) {
    assert.ok(
      rootLlms.includes(`${SITE.origin}${page.url}.md`),
      `the site llms.txt must link ${page.url}.md`,
    );
  }
});

test("the README describes the drive and points at the docs", () => {
  const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");
  // It is not the template stub any more: it says what the product is and
  // links every docs page, so a reader who lands on the repository has a way in.
  assert.doesNotMatch(
    readme,
    /node-repo-template/,
    "the README must not still be the template stub",
  );
  assert.match(readme, /^# Drive$/m, "the README must name the product");
  assert.match(readme, /2¢ per GB a month/, "the README must state the rate");
  for (const page of DOC_PAGES) {
    assert.ok(readme.includes(`${SITE.origin}${page.url}`), `the README must point at ${page.url}`);
  }
});

test("the docs carry the pricing page's design tokens, not a different palette", () => {
  // The site palette lives in the shared stylesheet (public/site.css, drive
  // #71), which the pricing page links; the docs site cannot import a served
  // asset, so the tokens are copied. This reads the shipped stylesheet and the
  // shipped theme, so a colour edited in one place without the other fails
  // here rather than shipping two products.
  const page = readFileSync(new URL("../public/site.css", import.meta.url), "utf8");
  const theme = readFileSync(
    new URL("../docs-site/.vitepress/theme/site.css", import.meta.url),
    "utf8",
  );
  for (const token of ["--paper", "--ink", "--ink-soft", "--rule", "--accent"]) {
    const from = page.match(new RegExp(`${token}:\\s*([^;]+);`));
    assert.ok(from, `the shared stylesheet must define ${token}`);
    assert.ok(
      theme.includes(`${token.replace("--", "--vp-")}`) ||
        theme.includes(`#${from[1].trim().replace("#", "")}`),
      `the docs theme must carry ${token} (${from[1].trim()}) from the pricing page`,
    );
  }
  // System fonts only: the pricing page ships no web font, so the docs must
  // not start one either.
  assert.doesNotMatch(theme, /@font-face/);
  assert.match(theme, /system-ui/);
});
