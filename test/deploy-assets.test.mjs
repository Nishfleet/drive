// What the deploy actually ships (drive issue #128).
//
// The docs are a generated section of the site: public/docs/ is gitignored
// (issue #98), so the only way the nine /docs/* pages and /docs/llms-full.txt
// ever reach the asset layer is a build that runs them, and the deploy's
// build step is `npm run build` — which is `cf build`, and cf build does not
// build the docs. For a while that meant a green deploy shipped a Worker with
// no docs at all while public/sitemap.xml and public/llms.txt, both committed
// on main, advertised every one of those URLs.
//
// This file is the gate on both halves. The first test pins the fix — a
// `prebuild` hook in package.json, the npm lifecycle hook that runs ahead of
// `npm run build`, which is the exact command the deploy runs. The hook lives
// in package.json rather than as a step in the deploy workflow because the
// deploy's own file is the fleet-standard one this App's token cannot write,
// and a hook cannot be stepped past: every `npm run build` runs it. The rest
// walk the committed discovery files against the directory the Worker is
// uploaded from (public/, which cf build copies into the assets), and serve
// that directory over HTTP to check the addresses the issue names answer.

import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { extname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { createMemoryStore } from "../core/keystore.js";
import { failureMessage } from "../core/messages.js";
import { absoluteUrl, DOC_PAGES as SEO_DOC_PAGES, SITE } from "../core/seo.js";
import worker from "../src/index.js";
import { DOC_PAGES } from "../src/render-docs.js";
import apiWorker, { dispatch } from "../workers/api/src/index.js";
import { API_PREFIX } from "../workers/api/src/routes.js";

/** @param {string} path @returns {string} */
const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

// The directory the Worker is uploaded from: cf build copies public/ into the
// asset layer, everything not routed to the Worker (cloudflare.config.ts:
// /api/* and /s/*). `npm test` runs `npm run docs:build` before the suite, so
// the docs are present here; a run without it says so rather than passing on
// nothing.
const publicDir = new URL("../public/", import.meta.url);

/**
 * The file a URL is served from in public/. The asset layer serves a clean URL
 * from its .html file — the docs are built `cleanUrls: true`, so /docs/quickstart
 * is public/docs/quickstart.html, and / is index.html — so the check is on the
 * shipped file, not on a directory entry named after the URL.
 * @param {string} path a site-root-relative path
 * @returns {string}
 */
function assetFileFor(path) {
  const relative = path.replace(/^\//, "");
  return relative === "" || relative === "/" ? "index.html" : relative;
}

/**
 * Whether a URL's file is in public/, allowing for the extension the clean-URL
 * build leaves off the address. /docs/quickstart is served from
 * quickstart.html; a URL that already carries its extension is served from
 * that file.
 * @param {string} path a site-root-relative path
 * @returns {boolean}
 */
function shipsAsset(path) {
  const file = assetFileFor(path);
  if (existsSync(new URL(file, publicDir))) return true;
  return existsSync(new URL(`${file}.html`, publicDir));
}

// The docs are generated into public/docs/ by the docs build the test run just
// performed. They are present or the tests below say so, rather than passing on
// an empty directory the way a check for the directory itself would.
const docsBuilt = existsSync(new URL("docs/quickstart.html", publicDir));

test("building the Worker builds the docs first, so the deploy ships them", () => {
  // The deploy's build step is `npm run build`, and npm runs the `prebuild`
  // lifecycle hook ahead of it. public/docs/ is generated and gitignored, so
  // the docs have to be built before cf build copies public/ into the uploaded
  // assets: a Worker built without them ships none, and it still goes green.
  const pkg = JSON.parse(read("package.json"));
  assert.equal(
    pkg.scripts.build,
    "cf build",
    "the deploy builds the Worker with `npm run build`, and that is cf build",
  );
  // The Node version check may run first, but nothing may run instead of the
  // docs build: drive#432 added the check ahead of the hook, and a hook that
  // stopped at the version check would ship a Worker with no docs.
  assert.match(
    pkg.scripts.prebuild,
    /^(npm run node:check && )?npm run docs:build$/,
    "the prebuild hook must still call `npm run docs:build`, with only the Node version check allowed in front",
  );
  // And the hook has to be the whole docs build, not the render step alone: a
  // hook that only rendered would write docs-site/.rendered and no page.
  assert.match(
    read("package.json"),
    /"docs:build": "npm run docs:render && vitepress build docs-site"/,
    "the prebuild hook must call the whole docs build, not the render step alone",
  );
});

test("every URL the committed sitemap advertises is a file the site ships", () => {
  // public/sitemap.xml is committed and hand-maintained, so it is exactly the
  // list that can promise a URL nothing serves.
  const sitemap = read("public/sitemap.xml");
  const locations = [...sitemap.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);
  assert.ok(locations.length > 0, "the sitemap lists at least the home page");
  for (const location of locations) {
    const path = new URL(location).pathname;
    assert.ok(
      shipsAsset(path),
      `${path} is in public/sitemap.xml but public/ ships no file for it: a listed URL that 404s is the drift drive#128 was filed for. Run \`npm run docs:build\` before reading this file.`,
    );
  }
});

test("the root llms.txt advertises only URLs the site ships", () => {
  // The same promise, in the file an answer engine reads. llms.txt links the
  // per-page Markdown copies and the bundle, all of which are build output.
  const llms = read("public/llms.txt");
  const links = [...llms.matchAll(/\]\((https?:\/\/[^)]+)\)/g)].map((m) => m[1]);
  assert.ok(links.length > 0, "llms.txt links its pages");
  for (const link of links) {
    const url = new URL(link);
    if (url.origin !== SITE.origin) continue; // an off-site link is not ours to ship
    assert.ok(
      shipsAsset(url.pathname),
      `llms.txt links ${url.pathname} but public/ ships no file for it (drive#128). Run \`npm run docs:build\` before reading this file.`,
    );
  }
});

test("every docs page in the sitemap ships as an HTML page and a .md copy", () => {
  // The two halves a reader can arrive by: a person follows the HTML, an agent
  // follows the Markdown. core/seo.js is the one list both the sitemap and
  // src/render-docs.js read, so a page cannot be built without being listed,
  // nor listed without being built.
  assert.ok(docsBuilt, "run `npm run docs:build`: public/docs/ was not built");
  for (const page of SEO_DOC_PAGES) {
    const name = page.path.replace("/docs/", "");
    assert.ok(
      existsSync(new URL(`docs/${name}.html`, publicDir)),
      `${page.path} must ship docs/${name}.html (drive#128)`,
    );
    assert.ok(
      existsSync(new URL(`docs/${name}.md`, publicDir)),
      `${page.path}.md is the agent-facing copy and must ship beside the page (drive#128)`,
    );
  }
  // The bundle llms.txt names, and the docs home, which is the one page with
  // no entry in DOC_PAGES because it is the table of contents.
  assert.ok(
    existsSync(new URL("docs/llms-full.txt", publicDir)),
    "llms.txt links /docs/llms-full.txt, so the bundle must ship (drive#128)",
  );
  assert.ok(
    existsSync(new URL("docs/index.html", publicDir)),
    "the docs home must ship: it is what the docs nav and the sitemap's first docs URL resolve to",
  );
});

test("the docs build is not a second hand-kept copy of the page list", () => {
  // src/render-docs.js derives the built files from core/seo.js, so the list
  // has one home. This asserts the derivation rather than the contents: a page
  // added to the sitemap by hand, with nothing behind it, fails the test above;
  // a page listed in core/seo.js with no Markdown behind it fails here.
  assert.deepEqual(
    DOC_PAGES.map((page) => page.url),
    SEO_DOC_PAGES.map((page) => page.path),
    "the docs build and the sitemap must read the same page list (core/seo.js)",
  );
  const built = readdirSync(new URL("../docs-site/", import.meta.url)).filter((name) =>
    name.endsWith(".md"),
  );
  // The home is rendered but not listed, so the authored sources are one more
  // file than DOC_PAGES names.
  assert.equal(
    built.length,
    DOC_PAGES.length + 1,
    `docs-site/ has ${built.length} authored pages for ${DOC_PAGES.length} listed ones plus index.md: a page that ships without being listed (or the other way round) is drift`,
  );
});

test("the site's own asset files ship, and the API is left to the Worker", () => {
  // SITE names the site-level paths; each one has to be a file, or a discovery
  // file points at nothing.
  for (const path of [SITE.homePath, SITE.robotsPath, SITE.sitemapPath, SITE.llmsPath]) {
    assert.ok(
      shipsAsset(path),
      `${absoluteUrl(path)} is a path core/seo.js declares and public/ does not carry (${assetFileFor(path)})`,
    );
  }
  // The asset layer's own contract (cloudflare.config.ts): /api/*, /s/* and
  // the api Worker's /v1/* family run the Worker, everything else is served
  // from the assets. The docs live under /docs/, which is asset territory, so
  // nothing has to route them.
  const config = read("cloudflare.config.ts");
  assert.match(
    config,
    /runWorkerFirst: \["\/api\/\*", "\/s\/\*", "\/v1\/\*"\]/,
    "the asset layer serves /docs/* as files: runWorkerFirst must be the API, share-link and api-Worker prefixes only",
  );
  // get-started.html is a built Vite entry from the repo root (issue #70), so
  // it is not in public/; every other committed file there is one cf build
  // copies into the assets.
  const rootPages = ["get-started.html"];
  for (const name of readdirSync(publicDir)) {
    if (name === "docs") continue; // generated by the docs build, checked above
    assert.ok(
      rootPages.includes(name) || existsSync(new URL(name, publicDir)),
      `public/${name} is committed and uploaded by cf build, but public/ does not carry it`,
    );
  }
});

test("the built assets carry CSP, frame-ancestors, nosniff, Referrer-Policy and HSTS", () => {
  // public/ is the directory cf build copies into the asset layer
  // (cloudflare.config.ts assets, this file's own comment). `_headers` is the
  // stock Workers Static Assets file that layer parses; it is not itself a
  // page. A missing file, or a file that drops one of these headers, is the
  // gap drive#506 names: files, usage, sign-in and upload ship with none of
  // them today because runWorkerFirst never sees those paths.
  const headers = read("public/_headers");
  assert.match(headers, /^\/\*/m, "the rules apply to every static path");
  assert.match(headers, /Content-Security-Policy:/);
  assert.match(headers, /frame-ancestors 'none'/);
  assert.match(headers, /X-Content-Type-Options:\s*nosniff/i);
  assert.match(headers, /Referrer-Policy:\s*no-referrer/i);
  assert.match(headers, /Strict-Transport-Security:/);
});

// ------------------------------------------------------------ served, not built

/**
 * The MIME types the served checks look for; anything else is bytes.
 * @type {Record<string, string>}
 */
const MIME_BY_EXT = { ".html": "text/html", ".txt": "text/plain", ".xml": "application/xml" };

/**
 * public/ over real HTTP. The Worker serves everything outside /api/* and
 * /s/* from the asset layer (cloudflare.config.ts), and cf build copies public/
 * into that layer, so "served" means the file over a fetch — not an
 * existsSync against the same directory the build wrote. The server resolves a
 * clean URL to its .html file the way the asset layer does.
 * @returns {Promise<{origin: string, close(): Promise<void>}>}
 */
async function serveSite() {
  const root = fileURLToPath(publicDir);
  const server = createServer((request, response) => {
    const relative = decodeURIComponent(new URL(request.url ?? "/", "http://x").pathname).replace(
      /^\//,
      "",
    );
    const candidates = relative === "" ? ["index.html"] : [relative, `${relative}.html`];
    const file = candidates.find((name) => {
      try {
        return statSync(join(root, name)).isFile();
      } catch {
        return false;
      }
    });
    if (!file) {
      response.writeHead(404).end();
      return;
    }
    response.setHeader("content-type", MIME_BY_EXT[extname(file)] ?? "application/octet-stream");
    response.writeHead(200);
    response.end(readFileSync(join(root, file)));
  });
  await new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve(undefined));
  });
  const address = server.address();
  assert.ok(address && typeof address === "object", "the server bound a port");
  return {
    origin: `http://127.0.0.1:${address.port}`,
    close: () =>
      new Promise((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  };
}

test("the pages the issue names are served from the shipped directory", async () => {
  // drive#128's acceptance: /, /llms.txt, /sitemap.xml and a built docs page.
  assert.ok(docsBuilt, "run `npm run docs:build`: public/docs/ was not built");
  const site = await serveSite();
  try {
    for (const [path, contentType] of [
      ["/", "text/html"],
      [SITE.llmsPath, "text/plain"],
      [SITE.sitemapPath, "application/xml"],
      [SEO_DOC_PAGES[0].path, "text/html"],
      // drive#584: the trust pages the launch checklist names, and the site's
      // own 5xx page. Each is a public/ asset the deploy copies verbatim.
      ["/accessibility.html", "text/html"],
      ["/status.html", "text/html"],
      ["/500.html", "text/html"],
    ]) {
      const response = await fetch(`${site.origin}${path}`);
      assert.equal(response.status, 200, `${path} must be served from public/`);
      const type = response.headers.get("content-type") ?? "";
      assert.ok(
        type.startsWith(contentType),
        `${path} answered content-type ${type}, expected ${contentType}`,
      );
      assert.ok((await response.text()).length > 0, `${path} served an empty body`);
    }
    // The new pages are reachable: the served copy of each links both, so a
    // person who lands on one can reach the other.
    for (const path of ["/accessibility.html", "/status.html"]) {
      const html = await (await fetch(`${site.origin}${path}`)).text();
      for (const link of ["/accessibility", "/status"]) {
        assert.ok(html.includes(`href="${link}"`), `${path} must link ${link}`);
      }
    }
    // The served sitemap is the committed one, byte for byte: the deploy ships
    // what main carries, not a stale copy from an earlier build.
    const served = await (await fetch(`${site.origin}${SITE.sitemapPath}`)).text();
    assert.equal(served, read("public/sitemap.xml"), "the served sitemap.xml is the committed one");
    // And the docs page's own agent-facing copy is served beside it, so an
    // answer engine reads the same words a person does.
    const markdown = await fetch(`${site.origin}${SEO_DOC_PAGES[0].path}.md`);
    assert.equal(markdown.status, 200, `${SEO_DOC_PAGES[0].path}.md must be served`);
    assert.match(await markdown.text(), new RegExp(`^# ${SEO_DOC_PAGES[0].title}$`, "m"));
  } finally {
    await site.close();
  }
});

// ------------------------------------- the api Worker's family on this one host
//
// One APIBase, two Workers (drive#156/#341, #342). The CLI posts /v1/* to the
// same base it posts /api/* to (cmd/drive/api.go), and the Worker that answers
// that address is the site Worker, so the family has to reach it — which is
// what the assets config above does — and be forwarded to the api Worker over
// the service binding (src/index.js). The api Worker is a separate deployable
// that no deploy ships yet, so the binding is absent until it does; these four
// checks are the whole contract in between.

/** An edge limit that allows, which is the shape the device routes call.
 * @returns {{limit(options: {key: string}): Promise<{success: boolean}>}}
 */
function allowAll() {
  return { limit: async () => ({ success: true }) };
}

const workerCtx = { waitUntil() {}, passThroughOnException() {} };

// The site Worker's own fetch, driven the way the platform drives it.
// `worker.fetch` is optional on the ExportedHandler type, so both calls go
// through these casts rather than restating a signature the tests would then
// have to keep true by hand.
const siteFetch =
  /** @type {(request: Request, env?: unknown, ctx?: {waitUntil(promise: Promise<unknown>): void, passThroughOnException(): void}) => Promise<Response>} */ (
    /** @type {unknown} */ (worker.fetch)
  );

/**
 * The api Worker's one route outside its /v1 family, forwarded from this
 * Worker's own route table ahead of the account gate (drive#354). Spelled here
 * as a literal, like every other path in src/index.js, and pinned against both
 * modules that serve it by this file and by workers/api/test/index.test.js.
 */
const REVOKE_PATH = "/api/keys/revoke";

/**
 * One site request, with the asset layer stubbed the way test/account-gate
 * stubs it (a 200 for anything that reaches the assets), so a request that fell
 * through to the asset layer instead of being answered is visible.
 * @param {Request} request
 * @param {Record<string, unknown>} [env] the bindings under test
 */
function siteRequest(request, env = {}) {
  return siteFetch(
    request,
    { ASSETS: { fetch: async () => new Response("asset", { status: 200 }) }, ...env },
    workerCtx,
  );
}

/** The api Worker's own fetch, driven with the bindings its routes read.
 * @type {(request: Request, env: unknown) => Promise<Response>}
 */
const apiFetch = /** @type {(request: Request, env: unknown) => Promise<Response>} */ (
  /** @type {unknown} */ (apiWorker.fetch)
);

test("the site Worker mounts the api registry's own family", async () => {
  // The prefix is the api registry's (workers/api/src/routes.js API_PREFIX,
  // the value every path in that registry starts with), so the site Worker's
  // route cannot drift from the routes the api Worker actually serves. Hono's
  // own registry is read here, the way test/account-gate.test.mjs reads it,
  // rather than matched as source text.
  const { createApp } = await import("../src/index.js");
  const mounted = createApp()
    .routes.map((route) => route.path)
    .filter((path) => path.startsWith(`${API_PREFIX}/`));
  assert.deepEqual(
    mounted,
    [`${API_PREFIX}/*`],
    `src/index.js must mount ${API_PREFIX}/* and nothing else, so the CLI's one APIBase reaches exactly the api Worker's family`,
  );
});

test("a /v1/* request crosses the service binding unchanged", async () => {
  // The forwarding half: the request the CLI sends is the request the api
  // Worker receives. Method, path, query, credential and body all carry over
  // untouched, so the api Worker's own gate, limits and words decide the answer
  // and this side cannot have rewritten the credential out from under them.
  /** @type {Request|null} */
  let seen = null;
  const response = await siteRequest(
    new Request("https://drive.test/v1/keys/k_1?dry=1", {
      method: "DELETE",
      headers: { authorization: "Bearer probe" },
      body: JSON.stringify({ scope: "u/acct-a/" }),
    }),
    {
      API: {
        fetch: (/** @type {Request} */ request) => {
          seen = request;
          return Promise.resolve(Response.json({ ok: true }, { status: 202 }));
        },
      },
    },
  );
  assert.equal(response.status, 202, "the api Worker's own status is the caller's status");
  assert.ok(seen, "the request must reach the binding");
  const forwarded = /** @type {Request} */ (seen);
  assert.equal(forwarded.method, "DELETE");
  assert.equal(new URL(forwarded.url).pathname, "/v1/keys/k_1", "the path is not rewritten");
  assert.equal(new URL(forwarded.url).search, "?dry=1", "the query is not dropped");
  assert.equal(
    forwarded.headers.get("authorization"),
    "Bearer probe",
    "the caller's own credential must reach the api Worker's account gate",
  );
  assert.equal(
    await forwarded.text(),
    JSON.stringify({ scope: "u/acct-a/" }),
    "the body is carried over",
  );
});

test("a deployment with no api binding is a closed door, not an open one", async () => {
  // drive-api is not deployed yet, so no binding exists: the family answers its
  // closed door instead of falling through to the asset layer, which would
  // serve the stubbed asset layer's 200 to a CLI that is trying to sign in.
  const response = await siteRequest(
    new Request("https://drive.test/v1/device/code", { method: "POST" }),
  );
  assert.equal(response.status, 503, "no binding means the family is not served");
  assert.deepEqual(
    await response.json(),
    { error: failureMessage("unexpected") },
    "the closed door speaks the one failure table's words (core/messages.js)",
  );
});

test("a binding that fails answers the one failure table's words", async () => {
  // A service Worker that throws mid sign-in: the family must not answer a
  // stack, or the asset layer's 404, or a bare Hono string. app.onError
  // (src/index.js) already maps an error raised anywhere on this app to the
  // message table's one sentence, and this is the check that holds the
  // property the caller actually sees when the api Worker is unreachable
  // behind the binding.
  const response = await siteRequest(new Request("https://drive.test/v1/health"), {
    API: {
      fetch: () => Promise.reject(new Error("the api Worker threw")),
    },
  });
  assert.equal(response.status, 500, "a throwing dependency is an error status, not an open one");
  assert.deepEqual(
    await response.json(),
    { error: failureMessage("unexpected") },
    "the message table speaks, whatever failed underneath it",
  );
});

test("a browser that asked for a page gets the site's 5xx page, not JSON", async () => {
  // drive#584: app.onError serves public/500.html when the request carries a
  // text/html Accept, so a person following a link does not land on a bare
  // JSON body. The JSON caller's answer above must not change, so this is the
  // page side of the same failure. The asset layer throws on the page request
  // and answers the 500 page, which is the real shape: the failure is wherever
  // the asset layer is.
  const page = read("public/500.html");
  const response = await siteRequest(
    new Request("https://drive.test/privacy", {
      headers: {
        accept: "text/html,application/xhtml+xml",
        // A cache modifier a page request carries: it must not ride onto the
        // error the route layer answers for the path (no-store is pinned).
        "cache-control": "max-age=3600",
      },
    }),
    {
      ASSETS: {
        fetch: (/** @type {Request} */ request) =>
          new URL(request.url).pathname === "/500.html"
            ? Promise.resolve(new Response(page, { status: 200 }))
            : Promise.reject(new Error("the asset layer threw")),
      },
    },
  );
  assert.equal(response.status, 500, "a failed page request is still a 500");
  const body = await response.text();
  assert.match(body, /That did not work/, "the browser gets the site's own words");
  assert.ok(!body.trimStart().startsWith("{"), "a browser is not handed JSON");
  assert.equal(
    response.headers.get("cache-control"),
    "no-store",
    "an error response is never cacheable, whatever the request asked for",
  );
  assert.equal(
    response.headers.get("x-robots-tag"),
    "noindex",
    "an error page stays out of a crawler's index",
  );
});

test("the 5xx page's asset layer going down falls back to the JSON table", async () => {
  // The same request with no ASSETS bound at all: the branch cannot serve the
  // page, so the caller keeps the one failure table's JSON. This is also the
  // no-ASSETS deployment, where the 500 branch is skipped on purpose.
  const response = await siteRequest(
    new Request("https://drive.test/privacy", {
      headers: { accept: "text/html,application/xhtml+xml" },
    }),
    {
      ASSETS: {
        fetch: () => Promise.reject(new Error("the asset layer is down entirely")),
      },
    },
  );
  assert.equal(response.status, 500, "the fall back answer is still a 500");
  assert.deepEqual(
    await response.json(),
    { error: failureMessage("unexpected") },
    "the fallback is the message table's own words, not a stack",
  );
});

test("a /v1/* caller that sent a browser Accept header still gets JSON", async () => {
  // drive#584: the page-vs-JSON choice must key off the route family, not the
  // Accept header. Java's HttpURLConnection sends
  // "text/html, image/gif, image/jpeg, *; q=.2, */*; q=.2" by default, so an
  // answer chosen on Accept alone would hand the CLI a page. The /v1/* family
  // is the api Worker's, so it keeps the message table's JSON.
  const response = await siteRequest(
    new Request("https://drive.test/v1/health", {
      headers: { accept: "text/html, image/gif, image/jpeg, *; q=.2, */*; q=.2" },
    }),
    {
      API: { fetch: () => Promise.reject(new Error("the api Worker threw")) },
      ASSETS: { fetch: async () => new Response("<html>page</html>", { status: 200 }) },
    },
  );
  assert.equal(response.status, 500, "a throwing dependency is an error status, not an open one");
  assert.deepEqual(
    await response.json(),
    { error: failureMessage("unexpected") },
    "an API caller keeps the JSON table whatever Accept it sent",
  );
});

test("an /api/* caller that sent a browser Accept header still gets JSON", async () => {
  // The sites route family's own case, beside the /v1/* one: the page-vs-JSON
  // choice keys off the family, so an /api/* route that threw keeps the
  // message table's JSON whatever Accept it carried. The route is the one
  // /api/* path that forwards to the api Worker (POST /api/keys/revoke), so a
  // throwing binding is the real shape.
  const response = await siteRequest(
    new Request("https://drive.test/api/keys/revoke", {
      method: "POST",
      headers: {
        accept: "text/html, image/gif, image/jpeg, *; q=.2, */*; q=.2",
        authorization: `Basic ${btoa("k_test:not-the-secret")}`,
      },
    }),
    {
      API: { fetch: () => Promise.reject(new Error("the api Worker threw")) },
      ASSETS: { fetch: async () => new Response("<html>page</html>", { status: 200 }) },
    },
  );
  assert.equal(response.status, 500, "a throwing dependency is an error status, not an open one");
  assert.deepEqual(
    await response.json(),
    { error: failureMessage("unexpected") },
    "an /api/* caller keeps the JSON table whatever Accept it sent",
  );
});

test("one host answers both families: the api Worker behind the binding", async () => {
  // The proof this issue asks for, at the level a worker can prove it: the
  // site's own route table, a service binding, and the api Worker's own
  // dispatcher behind it. The binding is injected, because no deployment has
  // produced one — drive-api is not deployed, and a real binding fails this
  // Worker's own deploy until it is — so what this proves is that the two
  // Workers compose through this route table, not that the live host answers.
  const env = {
    API: {
      fetch: (/** @type {Request} */ request) =>
        apiFetch(request, {
          DRIVE_DB: null,
          DEVICE_RATE_LIMITER: allowAll(),
          DEVICE_GLOBAL_RATE_LIMITER: allowAll(),
        }),
    },
  };
  const opened = await siteRequest(
    new Request("https://drive.test/v1/device/code", {
      method: "POST",
      headers: { "cf-connecting-ip": "198.51.100.7" },
    }),
    env,
  );
  assert.equal(opened.status, 200, "the device flow runs behind the site's route");
  const body = await opened.json();
  assert.ok(body.userCode.length > 0, "the api Worker minted the code the CLI shows");
  assert.match(String(body.verificationUri), /\/v1\/device\/approve$/);
  // And the family's liveness route, reachable only over this host for the
  // same reason, answers from the api Worker.
  const live = await siteRequest(new Request("https://drive.test/v1/health"), env);
  assert.equal(live.status, 200);
  assert.equal((await live.json()).ok, true);
});

test("this Worker mounts one /api/* route ahead of the gate, and it is the revoke (drive#354)", async () => {
  // The hole the forwarding makes in the deny-by-default /api/* gate, pinned
  // in the route table itself: this namespace carries the gate's own mount and
  // exactly one more, and that one is the api registry's single route outside
  // its /v1 family. Hono runs the first matching handler, so the order is the
  // security property and this walk is what keeps the two apart.
  const { createApp } = await import("../src/index.js");
  const routes = createApp().routes;
  // The account lane's own mounts: the gate, the browser-CSRF one and the one
  // forwarded route. Compared as paths, because that is the table that decides
  // order; a middlewares array is a library detail.

  // The account lane's own mounts, as paths, in the order Hono runs them: the
  // forwarded route, the gate, and one CSRF middleware on every /api/* write
  // (drive#506), after the gate so an anonymous request is 401 not 403.
  const lane = routes
    .filter((r) => r.method === "ALL" && r.path.startsWith("/api/"))
    .map((r) => r.path);
  assert.deepEqual(lane, [REVOKE_PATH, "/api/*", "/api/*"]);
  const forward = routes.findIndex((r) => r.path === REVOKE_PATH);
  const gate = routes.findIndex((r) => r.method === "ALL" && r.path === "/api/*");
  assert.ok(
    forward !== -1 && gate !== -1 && forward < gate,
    "the revoke is mounted ahead of the gate",
  );
  // And there is one forward, not two: the revoke and the /v1/* family go to the
  // api Worker through the same handler, so neither can be changed alone.
  const v1Forward = routes.find((r) => r.path === `${API_PREFIX}/*`);
  assert.ok(v1Forward, `the site Worker must forward ${API_PREFIX}/*`);
  assert.equal(routes[forward].handler, v1Forward.handler, "one forward serves both families");
});

test("POST /api/keys/revoke reaches the api Worker through the one host (drive#354)", async () => {
  // The issue's headline, at the level a worker can prove it: the api
  // registry's one route outside its /v1 family (`drive logout` posts it with
  // the key the rclone config holds, so no session exists to gate on) is
  // forwarded from the site's own route table over the service binding, ahead
  // of the deny-by-default /api/* gate that used to answer it 401. The binding
  // is injected for the same reason the /v1/* end-to-end test injects one:
  // drive-api is not deployed, and a real binding fails this Worker's own
  // deploy until it is.
  //
  // First the forwarding half: the request the CLI sends is the request the api
  // Worker receives — method, path and the caller's own Basic credential
  // unchanged — so the api Worker's own gate and words decide the answer.
  /** @type {Request|null} */
  let seen = null;
  const answered = await siteRequest(
    new Request(`https://drive.test${REVOKE_PATH}`, {
      method: "POST",
      headers: { authorization: `Basic ${btoa("k_test:not-the-secret")}` },
    }),
    {
      API: {
        fetch: (/** @type {Request} */ request) => {
          seen = request;
          return Promise.resolve(new Response(null, { status: 204 }));
        },
      },
    },
  );
  assert.equal(answered.status, 204, "the api Worker's own status is the caller's status");
  assert.ok(seen, "the request must reach the binding");
  const forwarded = /** @type {Request} */ (seen);
  assert.equal(forwarded.method, "POST");
  assert.equal(new URL(forwarded.url).pathname, REVOKE_PATH, "the path is not rewritten");
  assert.equal(
    forwarded.headers.get("authorization"),
    `Basic ${btoa("k_test:not-the-secret")}`,
    "the presented key reaches the api Worker that checks it",
  );

  // No binding: the same closed door the /v1/* family answers, not the gate's
  // 401 and not the asset layer's 200.
  const closed = await siteRequest(
    new Request(`https://drive.test${REVOKE_PATH}`, { method: "POST" }),
  );
  assert.equal(closed.status, 503, "no binding means the route is not served");
  assert.deepEqual(
    await closed.json(),
    { error: failureMessage("unexpected") },
    "the closed door speaks the one failure table's words (core/messages.js)",
  );

  // A throwing binding is the message table's one sentence, the same property
  // the /v1/* family holds.
  const threw = await siteRequest(
    new Request(`https://drive.test${REVOKE_PATH}`, { method: "POST" }),
    {
      API: { fetch: () => Promise.reject(new Error("the api Worker threw")) },
    },
  );
  assert.equal(threw.status, 500);
  assert.deepEqual(await threw.json(), { error: failureMessage("unexpected") });

  // The round trip the CLI makes, through the site's route table and the api
  // Worker's own dispatcher behind it: a key that works, revoked over this
  // host, then refused by the storage call that used it. The dispatcher is
  // driven directly (dispatch below) with the api Worker's own stand-in store,
  // because that is the shape a deployment without a database serves — and
  // because the device sign-in that mints the CLI's key is the api Worker's own
  // flow, proved in workers/api/test/key-revoke.test.js. What this test is
  // about is the route the site forwards.
  const store = createMemoryStore({ now: () => 0 });
  const key = await store.mintKey({ id: "acct_revoke" }, { kind: "agent", name: "claude" });
  const basic = { authorization: `Basic ${btoa(`${key.accessKeyId}:${key.secret}`)}` };
  const withApiStore = {
    API: {
      fetch: (/** @type {Request} */ request) =>
        dispatch(request, {
          env: { db: null },
          db: null,
          store,
          accounts: null,
          account: null,
          now: () => 0,
        }),
    },
  };
  const storage = `https://drive.test/v1/storage/list?path=${encodeURIComponent(key.prefix)}`;

  // The key works on the storage lane the one host also fronts.
  const alive = await siteRequest(new Request(storage, { headers: basic }), withApiStore);
  assert.equal(alive.status, 200, "the minted key works on the one host before the revoke");

  // `drive logout` posts the revoke to the same host, in this Worker's own
  // /api/* namespace, and the forwarding above gets it to the api Worker.
  const revoked = await siteRequest(
    new Request(`https://drive.test${REVOKE_PATH}`, { method: "POST", headers: basic }),
    withApiStore,
  );
  assert.equal(revoked.status, 204, "the presented key revoked itself through the one host");
  assert.equal(revoked.headers.get("cache-control"), "no-store");

  // And the same key is refused by the same lane afterwards.
  const dead = await siteRequest(new Request(storage, { headers: basic }), withApiStore);
  assert.equal(dead.status, 401, "the revoked key is dead on the one host");
  assert.equal(
    (await dead.json()).error,
    "This key was revoked or is not valid.",
    "the api Worker's own words answer, not a page from the site",
  );

  // No credentials at all is the api Worker's own 401 — never the site gate's,
  // and never a site page naming a route.
  const noKey = await siteRequest(
    new Request(`https://drive.test${REVOKE_PATH}`, { method: "POST" }),
    withApiStore,
  );
  assert.equal(noKey.status, 401);
  assert.equal(
    (await noKey.json()).error,
    "Provide the storage key to revoke as HTTP Basic credentials.",
  );
});
