// The production deploy's health smoke (drive#582).
//
// What it proves: the api Worker answers its own health route through
// Cloudflare Access with the service token, and the answer is HTTP
// 200 with {"ok": true}. Anything else — a non-200, a 200 whose body
// is not healthy, or no answer at all — exits non-zero, and the
// deploy step around this script rolls the Worker back to the
// previous version.
//
// The route answers only through Access, so the client id and secret
// come from the environment (CF_ACCESS_CLIENT_ID and
// CF_ACCESS_CLIENT_SECRET, the deploy's own secrets). A retry loop
// stands in for the curl --retry 5 --retry-delay 5 --retry-all-errors
// this script replaced: a fresh Worker can take a few seconds to
// answer, so a single bad attempt is not a failed deploy.
//
// Nothing here is a secret: the token is never printed, logged or
// echoed, and the headers travel in the request only.

/** The health route the deploy smokes, overridable for a test stub. */
const HEALTH_URL =
  process.env.HEALTH_URL ??
  "https://drive-pricing.nishant345.workers.dev/api/health";

/** Attempts and pause, the same shape the curl flags carried. */
const ATTEMPTS = Number(process.env.DRIVE_SMOKE_ATTEMPTS ?? 5);
const RETRY_DELAY_MS = Number(process.env.DRIVE_SMOKE_RETRY_DELAY_MS ?? 5000);

/**
 * One attempt's own ceiling. A Worker behind Access that is slow for 10
 * seconds straight is not healthy; without this a hanging route would
 * hang the deploy step for ever, which is the same "the deploy never
 * fails" outcome this script exists to prevent. Overridable so a test
 * can run the abort path in milliseconds.
 */
const PROBE_TIMEOUT_MS = Number(process.env.DRIVE_SMOKE_TIMEOUT_MS ?? 10000);

/** @returns {Headers | undefined} the Access service-token headers, when configured */
function accessHeaders() {
  const clientId = process.env.CF_ACCESS_CLIENT_ID;
  const clientSecret = process.env.CF_ACCESS_CLIENT_SECRET;
  if (!clientId || !clientSecret) return undefined;
  const headers = new Headers();
  headers.set("CF-Access-Client-Id", clientId);
  headers.set("CF-Access-Client-Secret", clientSecret);
  return headers;
}

/**
 * One attempt at the health route.
 * @returns {Promise<{ok: boolean, detail: string}>} ok is the whole
 * smoke's verdict for this attempt; detail says what was wrong.
 */
async function probe() {
  let response;
  try {
    response = await fetch(HEALTH_URL, {
      headers: accessHeaders(),
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
  } catch (error) {
    return { ok: false, detail: `no answer from ${HEALTH_URL} after ${PROBE_TIMEOUT_MS} ms: ${error}` };
  }
  const body = await response.text();
  if (response.status !== 200) {
    return { ok: false, detail: `health route answered ${response.status}` };
  }
  let parsed;
  try {
    parsed = JSON.parse(body);
  } catch {
    return { ok: false, detail: "health route answered 200 without JSON" };
  }
  if (parsed?.ok !== true) {
    return { ok: false, detail: `health route answered 200 but is not ok` };
  }
  return { ok: true, detail: "health route answered 200 with ok:true" };
}

/** @returns {Promise<number>} the exit code: 0 healthy, 1 anything else */
async function smoke() {
  let last = { ok: false, detail: "no attempt was made" };
  for (let attempt = 1; attempt <= ATTEMPTS; attempt += 1) {
    last = await probe();
    if (last.ok) {
      console.log(`smoke: ${last.detail}`);
      return 0;
    }
    if (attempt < ATTEMPTS) {
      console.log(`smoke: attempt ${attempt}/${ATTEMPTS}: ${last.detail}; retrying`);
      await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
    }
  }
  console.error(`smoke: FAILED after ${ATTEMPTS} attempts: ${last.detail}`);
  console.error("smoke: the deploy rolls back to the previous version");
  return 1;
}

process.exitCode = await smoke();

// A module, so the top-level await above type-checks.
export {};
