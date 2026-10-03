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
import worker from "../src/index.js";
import { failureMessage } from "../src/messages.js";
import { DOC_PAGES } from "../src/render-docs.js";
import { absoluteUrl, DOC_PAGES as SEO_DOC_PAGES, SITE } from "../src/seo.js";
import apiWorker from "../workers/api/src/index.js";
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
  assert.equal(
    pkg.scripts.prebuild,
    "npm run docs:build",
    "package.json needs a prebuild hook that runs `npm run docs:build`: cf build does not build the docs and public/docs/ is gitignored, so without the hook every deploy ships a Worker with no docs (drive#128)",
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
  // follows the Markdown. src/seo.js is the one list both the sitemap and
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
  // src/render-docs.js derives the built files from src/seo.js, so the list
  // has one home. This asserts the derivation rather than the contents: a page
  // added to the sitemap by hand, with nothing behind it, fails the test above;
  // a page listed in src/seo.js with no Markdown behind it fails here.
  assert.deepEqual(
    DOC_PAGES.map((page) => page.url),
    SEO_DOC_PAGES.map((page) => page.path),
    "the docs build and the sitemap must read the same page list (src/seo.js)",
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
      `${absoluteUrl(path)} is a path src/seo.js declares and public/ does not carry (${assetFileFor(path)})`,
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
    "the closed door speaks the one failure table's words (src/messages.js)",
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
