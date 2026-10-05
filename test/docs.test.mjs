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
  monthlyMaximumUsd,
} from "../src/billing.js";
import { FAQ, faqMarkdown, markerValues, RIVAL_1TB_LINE, scoreboardVerdict } from "../src/docs.js";
import { AGENT_TOOLS, KEY_POWERS } from "../src/keys.js";
import { PRICE } from "../src/pricing.js";
import { applyMarkers, DOC_PAGES, renderDocs } from "../src/render-docs.js";
import { PAGES, SITE } from "../src/seo.js";

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
// that stored `tb` terabytes all month is gb x 43,800 GB-minutes, whose
// average is the same gb. Nothing in these tests types a dollar figure.
/** @param {number} tb */
function billFor(tb) {
  const gb = tb * GB_PER_TB;
  return monthBillCents({ gbMinutes: gb * MINUTES_PER_MONTH });
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

// The cache numbers (drive issue #112) are the shipped defaults in
// cmd/drive/config.go, read here the way test/home-demos.test.mjs reads the
// mount's flags: a page that says 20G while the CLI mounts with 6G is a page
// that lies about the disk, so the two are one file apart and this is the gate
// between them.
test("the cache numbers on the pages are the ones the CLI mounts with", () => {
  const go = readFileSync(new URL("../cmd/drive/config.go", import.meta.url), "utf8");
  /** @param {string} name @returns {string} */
  const goConst = (name) => {
    const match = go.match(new RegExp(`${name}\\s*=\\s*"([^"]+)"`, ""));
    assert.ok(match, `${name} must be a Go string constant in cmd/drive/config.go`);
    return match[1];
  };
  const limit = goConst("vfsCacheMaxValue");
  const floor = goConst("vfsCacheMinFreeSpaceValue");
  for (const [file, name] of [
    ["how-it-works.md", "how it works"],
    ["limits.md", "limits"],
  ]) {
    const page = shipped(file);
    assert.ok(page.includes(limit), `${name} page must state the ${limit} cache limit`);
    assert.ok(page.includes(floor), `${name} page must state the ${floor} free-space floor`);
  }
  // And the marker the page uses renders from those constants, so the two
  // cannot be checked against the page but disagree with each other.
  assert.equal(
    markerValues().CACHE_LIMIT,
    limit,
    "the CACHE_LIMIT marker must be the CLI's own limit",
  );
  assert.equal(
    markerValues().CACHE_FLOOR,
    floor,
    "the CACHE_FLOOR marker must be the CLI's own floor",
  );
});

test("the pricing page carries the invoice's numbers, not typed ones", () => {
  const page = shipped("pricing.md");
  // The headline, the rule, no minimum and the cap, each
  // read from the one config the invoice reads.
  for (const line of [PRICE.headline, PRICE.rule, PRICE.noMinimumLine]) {
    assert.ok(page.includes(line), `the pricing page must state "${line}"`);
  }
  assert.ok(
    page.includes(`$${BILLING_CONFIG.maxUsdPerTb} per TB`),
    "the pricing page must state the maximum per TB",
  );
  assert.doesNotMatch(page, /membership|ceiling/i, "the pricing page must not name the old rule");
  assert.ok(
    page.includes(dollars(BILLING_CONFIG.defaultCapUsd)),
    "the pricing page must state the default cap",
  );
});

test("every worked example on the pricing page is the invoice's own arithmetic", () => {
  const page = shipped("pricing.md");
  for (const tb of [0.2, 0.8, 1.5, 3]) {
    const gb = tb * GB_PER_TB;
    const bill = billFor(tb);
    const row = `| ${tb} TB | ${dollars(meteredMonthlyBillUsd(gb * MINUTES_PER_MONTH))} | ${dollars(monthlyMaximumUsd(gb))} | ${dollars(bill.totalCents / 100)} |`;
    assert.ok(page.includes(row), `the pricing page must show the row: ${row}`);
  }
  // And the metered column is genuinely larger than the bill at the sizes the
  // maximum exists for, so the page cannot quietly drop the maximum.
  assert.ok(
    meteredMonthlyBillUsd(2 * GB_PER_TB * MINUTES_PER_MONTH) > billFor(2).totalCents / 100,
    "2 TB metered must be more than 2 TB billed, or the maximum is not being applied",
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
  assert.ok(page.includes("drive init"), "the agents page must name drive init");
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

test("the security page answers whether writing resumes once the cap is raised", () => {
  // The gap issue #303 names, from both directions. A train task of the agent
  // eval (#222) was dropped because its answer is nowhere in the reading
  // stack: docs-site/*.md and `drive --help` both said the drive goes read-only
  // at the cap, and neither said what raising it does. The pages an agent
  // reads were also the only place the answer could live, because the code that
  // decides it (src/cap.js `capSwapPlan`, whose mount plan `drive cap` acts on)
  // is not served. So the answer is one sentence on the page that already
  // states the cap, and this pins it: an eval cannot grade an answer the
  // reading stack does not carry, and a page that loses the sentence fails here
  // rather than in the next run's score.
  const page = shipped("security.md");
  assert.match(
    page,
    /raise the cap and the drive starts writing again/i,
    "the security page must say writing resumes once the cap is raised",
  );
  assert.match(
    page,
    /uploads that waited in the cache go up/i,
    "the security page must say the uploads that waited are sent",
  );
});

test("the limits page is honest: not open, no install script, and the CLI gaps named", () => {
  const page = shipped("limits.md");
  assert.match(page, /not open yet/i, "the limits page must say the drive is not open");
  assert.match(
    page,
    /the\s+install\s+that\s+works\s+today\s+is\s+to\s+build\s+the\s+command\s+from\s+this\s+repository's\s+source\s+with\s+the\s+Go\s+toolchain/i,
    "the limits page must give the install that works today",
  );
  assert.match(
    page,
    /drive --help/,
    "the limits page must point at the command's own words for the exact route",
  );
  assert.match(
    page,
    /slower than the alternatives/i,
    "the limits page must say where we lose to rivals",
  );
  // Commands the CLI does not have (cmd/drive/main.go's switch) must be on the
  // page as "not in the CLI", never shown as working. A test cannot read the Go
  // switch, so this pins the one that the docs otherwise lean on. `branch` used
  // to be on this list: cmd/drive/main.go now ships branch, branches, diff,
  // approve and discard, and the agents page documents them (issue #306), so
  // the gap line was removed and the page must not claim the gap anymore.
  for (const missing of ["restore"]) {
    assert.match(
      page,
      new RegExp(`No \`${missing}\` command yet|No branch or approve commands`),
      `the limits page must say there is no ${missing} command yet`,
    );
  }
  assert.doesNotMatch(
    page,
    /No branch or approve commands/,
    "branch and approve ship today, so the limits page must not call them a gap",
  );
  assert.match(
    page,
    /`?drive (branch|approve)`?/,
    "the limits page must speak of branch and approve as commands that exist",
  );
});

test("the changelog opens today and every entry is a real line", () => {
  const page = shipped("changelog.md");
  assert.match(page, /## \d{4}-\d{2}-\d{2}/, "the changelog must open with a date heading");
  assert.ok(
    page.includes(`$${BILLING_CONFIG.maxUsdPerTb} per TB`),
    "the changelog must state the maximum it recorded",
  );
});

test("the changelog's docs list names every page in DOC_PAGES order", () => {
  // The changelog repeats the docs list in prose ("These docs: ..."), a second
  // copy of src/seo.js DOC_PAGES. drive#282: Benchmarks was in DOC_PAGES, the
  // sitemap and the built site, but not in this sentence, so an agent reading
  // the changelog missed a shipped page. The gate reads that one sentence and
  // requires every DOC_PAGES title, in the same order, so the next page added
  // to DOC_PAGES fails here until the changelog names it.
  const changelog = shipped("changelog.md");
  const bullet = changelog.match(/[*-] These docs:([\s\S]*?)(?=\n[*-] |\n\n)/);
  assert.ok(bullet, "the changelog must carry its 'These docs:' list");
  const names = bullet[1].replace(/\s+/g, " ").toLowerCase();
  let at = -1;
  for (const page of DOC_PAGES) {
    const found = names.indexOf(page.title.toLowerCase(), at + 1);
    assert.ok(
      found > at,
      `the changelog's docs list must name ${page.title} after the page before it`,
    );
    at = found;
  }
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

test("the FAQ does not name a rival or quote a rival's price", () => {
  const faq = shipped("faq.md");
  // Drive#387: public copy uses our words. The scoreboard still records the
  // rival's 1 TB figures internally, and the line is kept in src/docs.js so
  // this test can prove the FAQ never quotes it.
  assert.equal(faq.includes(RIVAL_1TB_LINE), false, "the FAQ must not quote the rival line");
  assert.doesNotMatch(faq, /\bSpace\b/);
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

test("no docs page claims a cross-machine sync time the scoreboard has not measured", () => {
  // drive#275: how-it-works.md and public/llms.txt said a save reaches storage
  // "a few seconds after you close the file" and appears on the other machines,
  // while the scoreboard's "cross-machine sync time" row says not yet measured
  // for two real machines (the row's own issue is #121) and the Benchmarks page
  // opens by promising nothing is estimated. Same drift shape as #133, one row
  // over. The wording is downgraded, and this gate keeps it downgraded: while
  // the row is unmeasured, a page may not pair a cross-machine claim with a
  // stated duration. The gate reads the row's verdict, so the day #121 lands a
  // real measurement the pages may carry the figure again without editing this
  // test. The drift sat across a line break, so each surface is folded to one
  // line first, the way the shipped page reads.
  const SYNC_ROW = "cross-machine sync time";
  const SYNC_ISSUE = 121;
  const VERDICTS = ["win", "lose", "not yet measured"];
  const verdict = scoreboardVerdict(scoreboard, SYNC_ROW);
  assert.ok(
    VERDICTS.includes(verdict),
    `docs/scoreboard.md's "${SYNC_ROW}" row carries verdict "${verdict}", which is not one this gate knows`,
  );
  if (verdict === "win") {
    // The row is measured, so a figure on a page is a claim the scoreboard
    // backs and this gate has nothing left to say about it.
    return;
  }
  /** Fold a rendered page to one line, so a sentence hard-wrapped in the source
   * is checked as the one sentence a reader sees. @param {string} text */
  const fold = (text) => text.replace(/\r?\n/g, " ");
  // Every surface a person or an agent reads: the nine docs pages, read as the
  // build wrote them, and the site-wide llms.txt the pages are listed in.
  /** @type {Array<[string, string]>} */
  const surfaces = [
    .../** @type {Array<[string, string]>} */ (
      DOC_PAGES.map((page) => [page.file, fold(shipped(page.file))])
    ),
    ["public/llms.txt", fold(readFileSync(new URL("../public/llms.txt", import.meta.url), "utf8"))],
  ];
  // A duration beside a save arriving on another machine, either order, held to
  // one table cell or sentence by [^|]{0,160} (excludes markdown table pipes, so
  // the Benchmarks table's own figures cannot chain across cells). "a few
  // seconds", "within 5 s", "in seconds", "half a second", "a few minutes".
  const machineMention =
    /\b(?:other machines?|another machine|other computers?|another computer|other macs?|another mac|other devices?|another device|across machines|both machines)\b/i;
  const duration =
    /\b(?:a |an |about |around |in |within |under |over |after )?(?:few|couple(?: of)?|half an?|one|two|three|four|five|ten|\d[\d.]*)\s*(?:milliseconds?|ms|seconds?|secs?|minutes?|mins?)\b|\b(?:within|in|under|over|about|after)\s+(?:a |an )?(?:few|couple of|half an?|\d[\d.]*)?\s*(?:seconds?|minutes?|milliseconds?|ms)\b/i;
  const timeThenMachine = new RegExp(
    `(?:${duration.source})[^|]{0,160}?(?:${machineMention.source})`,
    "i",
  );
  const machineThenTime = new RegExp(
    `(?:${machineMention.source})[^|]{0,160}?(?:${duration.source})`,
    "i",
  );
  for (const [name, text] of surfaces) {
    assert.doesNotMatch(
      text,
      timeThenMachine,
      `${name} states how long a save takes to cross to another machine, and the scoreboard's "${SYNC_ROW}" row is not yet measured (issue #${SYNC_ISSUE}: two real machines)`,
    );
    assert.doesNotMatch(
      text,
      machineThenTime,
      `${name} states how long a save takes to cross to another machine, and the scoreboard's "${SYNC_ROW}" row is not yet measured (issue #${SYNC_ISSUE}: two real machines)`,
    );
  }
  // And the two surfaces the drift was found on keep the honest sentence, so a
  // reword that drops the "not yet measured" instead of the figure fails here.
  const downgraded = /(?:a save|save) takes[^.;]{0,80}not yet measured/i;
  const howItWorks = surfaces.find(([name]) => name === "how-it-works.md");
  const rootLlms = surfaces.find(([name]) => name === "public/llms.txt");
  assert.ok(howItWorks, "the how-it-works page must be one of the surfaces");
  assert.ok(rootLlms, "the root llms.txt must be one of the surfaces");
  assert.match(
    howItWorks[1],
    downgraded,
    "how-it-works.md must say how long a save takes is not yet measured",
  );
  assert.match(
    rootLlms[1],
    downgraded,
    "public/llms.txt must say how long a save takes is not yet measured",
  );
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

test("the sitemap lists the home page and the indexable pages, then every docs page, in order", () => {
  const sitemap = readFileSync(new URL("../public/sitemap.xml", import.meta.url), "utf8");
  const locations = [...sitemap.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);
  // The indexable pages come from src/seo.js PAGES rather than a typed path,
  // so a page that moves there moves this expectation with it instead of the
  // test and the sitemap drifting together.
  assert.deepEqual(
    locations,
    [
      ...PAGES.filter((page) => page.indexable).map((page) => page.path),
      ...DOC_PAGES.map((page) => page.url),
    ].map((path) => `${SITE.origin}${path}`),
    "the sitemap must list every indexable page and every docs page, in order",
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
  // against the command table in cmd/drive/main.go (the one place a
  // subcommand exists: the dispatch reads it, and Go-side gates hold the
  // agent notes and the help text to it), and the one sample that
  // is not a `drive` command is pinned by name. A renamed or removed
  // subcommand fails the build instead of shipping a sample that does nothing.
  const mainGo = readFileSync(new URL("../cmd/drive/main.go", import.meta.url), "utf8");
  const tableStart = mainGo.indexOf("var commands = map[string]func([]string) error{");
  const tableBody = mainGo.slice(tableStart, mainGo.indexOf("}", tableStart));
  const subcommands = new Set([...tableBody.matchAll(/"([a-z]+)":/g)].map((m) => m[1]));
  assert.ok(
    subcommands.has("mount") && subcommands.has("init"),
    "the subcommand list must have been parsed out of main.go",
  );

  // The commands a page may show, outside `drive <sub>`. Each is a stock tool
  // invocation the page explains in prose; adding one is a deliberate edit.
  const nonDriveSamples = new Set([
    "brew install drive",
    "sudo apt install drive",
    "sudo dnf install drive",
    "goreleaser release --snapshot --clean",
    "export DRIVE_S3_ENDPOINT=https://your-endpoint",
    "export DRIVE_S3_BUCKET=your-bucket",
    "export DRIVE_S3_PREFIX=your-folder",
    "export DRIVE_S3_ACCESS_KEY_ID=...",
    "export DRIVE_S3_SECRET_ACCESS_KEY=...",
    "rclone config",
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
  assert.ok(readme.includes(PRICE.headline), "the README must state the price");
  for (const page of DOC_PAGES) {
    assert.ok(readme.includes(`${SITE.origin}${page.url}`), `the README must point at ${page.url}`);
  }
});

test("the shipped docs do not preload Inter", () => {
  // VitePress's default theme preloads Inter. transformHtml strips those
  // tags (drive#458 CLS). A path-shape change that lets a tag through fails
  // here rather than shipping a 0.015 layout shift.
  const html = shipped("index.html");
  assert.doesNotMatch(html, /inter-/i, "the docs HTML must not preload or link Inter");
});

test("the docs carry the home page's design tokens, not a different palette", () => {
  // The site palette lives in the shared stylesheet (public/site.css, drive
  // #71 / #152 / #458), which the pricing page links; the docs site cannot
  // import a served asset, so the tokens are copied. This reads the shipped
  // stylesheet and the shipped theme, so a colour edited in one place without
  // the other fails here rather than shipping two products.
  const page = readFileSync(new URL("../public/site.css", import.meta.url), "utf8");
  const theme = readFileSync(
    new URL("../docs-site/.vitepress/theme/site.css", import.meta.url),
    "utf8",
  );
  for (const token of [
    "--drive-paper",
    "--drive-ink",
    "--drive-ink-soft",
    "--drive-line",
    "--drive-orange",
    "--drive-orange-ink",
    "--drive-card",
  ]) {
    const from = page.match(new RegExp(`${token}:\\s*([^;]+);`));
    assert.ok(from, `the shared stylesheet must define ${token}`);
    assert.ok(
      theme.includes(from[1].trim()),
      `the docs theme must carry ${token} (${from[1].trim()}) from the home page`,
    );
  }
  // Same three self-hosted faces as the home page, swap, no Google Fonts.
  assert.doesNotMatch(theme, /fonts\.(googleapis|gstatic)\.com/);
  const faces = (theme.match(/@font-face\s*\{[\s\S]*?\}/g) ?? []).filter((face) =>
    face.includes("url("),
  );
  assert.equal(faces.length, 6, "the docs theme ships the same six face files as public/site.css");
  for (const face of faces) {
    assert.match(face, /font-display: swap/);
    assert.match(face, /url\("\/fonts\/[^"]+\.woff2"\)/);
  }
});
