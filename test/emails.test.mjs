// Every drive email, every branch. The copy is a decision (docs/build-spec.md,
// "Nothing missing": welcome, 80% of cap, read-only reached, payment failed,
// monthly receipt with the "you saved" line), so the tests pin the sentences,
// the numbers and the two "you saved" baselines from drive#39 rather than
// letting a later run quietly reword a customer's inbox.
//
// No Worker runtime: sendEmail takes the binding as an argument, so a fake
// records what would have gone out and the templates run through node --test.

import assert from "node:assert/strict";
import { test } from "node:test";
import { BILLING_CONFIG } from "../src/billing.js";
import {
  handleSendEmailRequest,
  isAuthorizedSend,
  isSameOriginRequest,
  sendEmail,
} from "../src/email-send.js";
import {
  capWarningTemplate,
  DEFAULT_CAP_USD,
  EMAIL_KINDS,
  FROM_NAME,
  monthlyReceiptTemplate,
  paymentFailedTemplate,
  RATE_USD_PER_GB,
  readOnlyTemplate,
  renderEmail,
  SAVED_COPY,
  savedLine,
  welcomeTemplate,
} from "../src/emails.js";
import { SIGN_IN_COMMAND } from "../src/messages.js";
import { INSTALL_COMMAND } from "../src/status.js";

// The deployment's sending address, set per deployment (the sending domain is
// a deployment decision, not a code one).
const MAIL_FROM = "notifications@drive.example";

/**
 * A fake send_email binding: records the message, and can be told to fail.
 * @param {Error | {messageId?: unknown} | null} [result]
 */
function makeFakeEmail(result = { messageId: "<fake@drive.example>" }) {
  /** @type {unknown[]} */
  const sent = [];
  return {
    sent,
    /**
     * @param {unknown} message
     * @returns {Promise<{messageId: string}>}
     */
    async send(message) {
      sent.push(message);
      if (result instanceof Error) {
        throw result;
      }
      return /** @type {{messageId: string}} */ (result);
    },
  };
}

// The route's own token, and an env carrying it.
const TOKEN = "test-send-token";
/** @param {Record<string, unknown>} [overrides] */
function makeEnv(overrides = {}) {
  return {
    EMAIL: makeFakeEmail(),
    EMAIL_SEND_TOKEN: TOKEN,
    MAIL_FROM,
    ...overrides,
  };
}

/**
 * @param {unknown} body
 * @param {Record<string, string>} [headers]
 */
function postRequest(body, headers = {}) {
  return new Request("https://drive.example/api/emails/send", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

/**
 * @param {unknown} body
 * @param {Record<string, string>} [extra]
 */
function authed(body, extra = {}) {
  return postRequest(body, { authorization: `Bearer ${TOKEN}`, ...extra });
}

// ---------------------------------------------------------------------------
// The five kinds
// ---------------------------------------------------------------------------

test("the emails include the spec's money kinds and the close kinds", () => {
  assert.deepEqual(EMAIL_KINDS, [
    "welcome",
    "cap-warning",
    "read-only",
    "payment-failed",
    "monthly-receipt",
    "account-closed",
    "account-close-reminder",
    "top-up-receipt",
    "low-balance",
    "device-approve-notice",
  ]);
});

test("every kind renders a subject and both body parts", () => {
  // No kind may ship HTML-only or text-only: some clients show only the text
  // part, and a text part is a large part of the spam score.
  for (const kind of EMAIL_KINDS) {
    const { subject, text, html } = renderEmail(kind, dataFor(kind));
    assert.ok(subject.length > 0, `${kind} needs a subject`);
    assert.ok(text.length > 0, `${kind} needs a text part`);
    assert.ok(html.includes("<html"), `${kind} needs an HTML part`);
    assert.ok(html.includes(`<p>`), `${kind}'s HTML needs paragraphs`);
  }
});

test("every email carries one sign-off, in both parts", () => {
  for (const kind of EMAIL_KINDS) {
    const { text, html } = renderEmail(kind, dataFor(kind));
    assert.equal(text.split("-- Drive").length - 1, 1, `${kind} text sign-off`);
    assert.equal(html.split("-- Drive").length - 1, 1, `${kind} html sign-off`);
  }
});

// ---------------------------------------------------------------------------
// 1) welcome
// ---------------------------------------------------------------------------

// Two commands, in this order, and each named once: `drive login` signs the
// machine in and writes the storage settings, and `drive init` then mounts and
// connects the agent tools (drive#557). The old copy had a single `drive init`
// doing both jobs, which sent people to a command that cannot sign them in.
test("welcome names the sign-in and the setup, once each, in that order", () => {
  const { subject, text, html } = welcomeTemplate();
  assert.equal(subject, "Your drive is ready");
  assert.equal(text.split(SIGN_IN_COMMAND).length - 1, 1, "the sign-in is named once");
  assert.equal(text.split(INSTALL_COMMAND).length - 1, 1, "the setup is named once");
  assert.ok(
    text.indexOf(SIGN_IN_COMMAND) < text.indexOf(INSTALL_COMMAND),
    "the sign-in comes first: init needs the settings login writes",
  );
  // One install path, not two: the CLI ships with build step 2 (drive#3) and
  // there is no app to download.
  assert.equal(html.split(INSTALL_COMMAND).length - 1, 1, "the html names the setup once");
  assert.equal(html.split(SIGN_IN_COMMAND).length - 1, 1, "the html names the sign-in once");
  assert.match(text, /read-only/);
  // The cap is the one thing a new person is told they control.
  assert.match(text, /spending cap/i);
});

// ---------------------------------------------------------------------------
// 2) cap warning at 80%
// ---------------------------------------------------------------------------

test("the cap warning fires at 80% and names the cap in dollars", () => {
  const { subject, text } = capWarningTemplate({ capUsd: 12 });
  assert.match(subject, /80%/);
  assert.match(text, /80% of your \$12\.00 spending cap/);
  // 80% of a $12 cap is $9.60: the reader can check the warning against the
  // cap without doing anything. Rounded money, not float bits.
  assert.equal(DEFAULT_CAP_USD, BILLING_CONFIG.defaultCapUsd, "emails copy the one default");
  assert.equal(DEFAULT_CAP_USD, 20, "the default cap is $20 (drive#464)");
  assert.equal((0.8 * DEFAULT_CAP_USD).toFixed(2), "16.00");
});

test("the cap warning defaults to the decided cap and carries it in both parts", () => {
  // The template requires the cap, so a caller that means the default passes
  // it explicitly; both paths render the same message.
  const withDefault = capWarningTemplate({ capUsd: DEFAULT_CAP_USD });
  assert.match(withDefault.html, /\$20\.00/);
  assert.match(withDefault.text, /\$20\.00/);
});

test("a cap warning with no usable cap is a loud error, not a $0 email", () => {
  // Never swallow an error: an account's cap may not be $12, so a missing cap
  // must not silently send the default ("you have used 80% of your $12.00
  // spending cap") for someone who set $50. Every unusable value throws.
  for (const capUsd of [undefined, null, Number.NaN, -1, "12"]) {
    assert.throws(() => capWarningTemplate({ capUsd }), TypeError, `capUsd ${capUsd}`);
    assert.throws(() => readOnlyTemplate({ capUsd }), TypeError, `capUsd ${capUsd}`);
  }
  assert.throws(() => readOnlyTemplate({}), TypeError);
  assert.throws(() => capWarningTemplate(), TypeError);
  assert.throws(() => paymentFailedTemplate({ amountUsd: undefined }), TypeError);
  assert.throws(() => monthlyReceiptTemplate({ billUsd: -1 }), TypeError);
});

test("the cap warning says nothing is deleted", () => {
  // The cap is the scariest mail the product sends, and "nothing is deleted"
  // is the sentence that has to be in it (build-spec.md "Spending cap").
  const { text, html } = capWarningTemplate({ capUsd: 12 });
  assert.match(text, /Nothing is deleted/);
  assert.match(html, /Nothing is deleted/);
});

// ---------------------------------------------------------------------------
// 3) read-only reached
// ---------------------------------------------------------------------------

test("read-only names the cap, says nothing is deleted, and gives the way back", () => {
  const { subject, text, html } = readOnlyTemplate({ capUsd: 12 });
  assert.match(subject, /read-only/);
  assert.match(text, /\$12\.00 spending cap and is now read-only/);
  assert.match(text, /Nothing is deleted/);
  assert.match(html, /Nothing is deleted/);
  // The next step, both ways a person can take it.
  assert.match(text, /billing portal/);
  assert.match(text, /drive cap <dollars>/);
});

test("read-only still says the files are readable", () => {
  const { text } = readOnlyTemplate({ capUsd: 12 });
  assert.match(text, /still readable/);
});

// ---------------------------------------------------------------------------
// 4) payment failed
// ---------------------------------------------------------------------------

test("payment failed names the amount and the way to fix it", () => {
  const { subject, text, html } = paymentFailedTemplate({ amountUsd: 23.5 });
  assert.match(subject, /payment did not go through/);
  assert.match(text, /could not charge \$23\.50/);
  assert.match(html, /\$23\.50/);
  // The fix, and the reassurance: a failed card is not a lost drive.
  assert.match(text, /billing portal/);
  assert.match(text, /Your files are safe/);
});

test("payment failed never blames the person", () => {
  // Nish's north star (drive#35): say what happened and what to do, not who is
  // at fault. The banned words are the ones that turn a card problem into a
  // blame message.
  const { text } = paymentFailedTemplate({ amountUsd: 4 });
  for (const blame of ["your fault", "you failed", "declined card", "expired card"]) {
    assert.equal(text.toLowerCase().includes(blame), false, `no "${blame}"`);
  }
});

// ---------------------------------------------------------------------------
// 5) monthly receipt, with the "you saved" line
// ---------------------------------------------------------------------------

/** @param {Record<string, unknown>} [overrides] */
function receiptData(overrides = {}) {
  return {
    // October 2026, sent the way the Worker sends it: the month's own first
    // instant, UTC (drive#559). The receipt names the month it bills for, so
    // "this month" is never what a reader opens in a later month.
    monthIso: "2026-10-01T00:00:00.000Z",
    billUsd: 12,
    meteredUsd: 16,
    ceilingUsd: 12,
    capped: true,
    ...overrides,
  };
}

// The data each kind actually takes. A kind rendered with another kind's data
// must fail loudly (see the "no usable cap" test), so the loop tests use this
// rather than one blob for all five.
/** @param {string} kind */
function dataFor(kind) {
  switch (kind) {
    case "welcome":
      return {};
    case "cap-warning":
      return { capUsd: 12 };
    case "read-only":
      return { capUsd: 12 };
    case "payment-failed":
      return { amountUsd: 23.5 };
    case "monthly-receipt":
      return receiptData();
    case "account-closed":
    case "account-close-reminder":
      return { graceDays: 30, reminderDays: 25, purgeOn: "3 Nov (UTC)" };
    case "top-up-receipt":
      return { amountUsd: 25, balanceUsd: 31.5, auto: false };
    case "low-balance":
      return { balanceUsd: 1.8, autoTopUpUsd: null };
    case "device-approve-notice":
      return { deviceName: "office laptop", requestedAt: "2026-10-05T12:00:00.000Z" };
    default:
      throw new Error(`no test data for ${kind}`);
  }
}

test("a capped month says our price cap saved you, metered minus bill", () => {
  // drive#39, decision 1: capped month -> saved = metered - bill.
  // 16 metered against a 12 bill: the cap saved $4.
  const { text, html, saved } = monthlyReceiptTemplate(receiptData());
  assert.equal(saved, "Our price cap saved you $4.00");
  assert.match(text, /Our price cap saved you \$4\.00/);
  assert.match(html, /Our price cap saved you \$4\.00/);
  assert.match(text, /bill for October 2026, UTC is \$12\.00/);
});

test("an uncapped month says you paid less than a flat plan, ceiling minus bill", () => {
  // drive#39, decision 1: uncapped month -> saved = ceiling - bill. 0.6 TB
  // metered at 2c/GB is $12, and the ceiling for the month is $23.
  const { text, saved } = monthlyReceiptTemplate(
    receiptData({ billUsd: 12, meteredUsd: 12, ceilingUsd: 23, capped: false }),
  );
  assert.equal(saved, "You paid $11.00 less than a flat plan");
  assert.match(text, /You paid \$11\.00 less than a flat plan/);
});

test("the saved line is hidden when the saving is zero or less", () => {
  // drive#39: "Hidden when <= 0". One consistent case per baseline (the bill
  // is min(metered, ceiling), so these are real months): a capped month where
  // the meter equals the bill, and an uncapped month that reached the ceiling
  // exactly.
  for (const month of [
    { meteredUsd: 12, billUsd: 12, ceilingUsd: 12, capped: true },
    { meteredUsd: 12, billUsd: 12, ceilingUsd: 12, capped: false },
  ]) {
    assert.equal(savedLine(month), null);
    const { text, html, saved } = monthlyReceiptTemplate({ ...receiptData(), ...month });
    assert.equal(saved, null);
    assert.equal(/saved you|less than a flat plan/.test(text), false);
    assert.equal(/saved you|less than a flat plan/.test(html), false);
  }
});

test("a receipt is built from months that can actually happen", () => {
  // The receipt says the bill is min(metered, ceiling). A caller that passes
  // a bill above the meter (or above the ceiling) has a bug upstream; this
  // pins the arithmetic on real, consistent months rather than on an
  // impossible one.
  // 0.6 TB metered at 2c/GB = $12, ceiling $23 (uncapped): bill $12, saved $11.
  const uncapped = monthlyReceiptTemplate(
    receiptData({ billUsd: 12, meteredUsd: 12, ceilingUsd: 23, capped: false }),
  );
  assert.equal(uncapped.saved, "You paid $11.00 less than a flat plan");
  // 2 TB peak: meter $40, ceiling $23 (capped): bill $23, saved $17.
  const capped = monthlyReceiptTemplate(
    receiptData({ billUsd: 23, meteredUsd: 40, ceilingUsd: 23, capped: true }),
  );
  assert.equal(capped.saved, "Our price cap saved you $17.00");
  assert.match(capped.text, /bill for October 2026, UTC is \$23\.00/);
});

test("savedLine refuses a month with nonsense in it", () => {
  for (const month of [
    null,
    "12",
    {},
    { meteredUsd: -1, billUsd: 0, ceilingUsd: 0, capped: true },
  ]) {
    assert.throws(() => savedLine(month), TypeError);
  }
});

test("the receipt names the month it bills, and says the month is UTC", () => {
  // drive#559, acceptance 3. A mail is read days later, so "this month" is
  // whatever month the reader is in now: the subject and the first line name
  // the month the numbers belong to, and the one sentence under it says that
  // the month is a UTC month.
  const { subject, text, html } = monthlyReceiptTemplate(receiptData());
  assert.match(subject, /Your Drive receipt: October 2026, UTC$/);
  assert.match(text, /Your Drive bill for October 2026, UTC is \$12\.00\./);
  // The UTC rule in one sentence, the same words the usage page states.
  assert.match(text, /Drive bills whole months in UTC:/);
  assert.match(text, /00:00 on the 1st/);
  assert.match(html, /October 2026, UTC/);
  // A different month is named as itself, not offset or rolled: the label comes
  // from the instant the Worker sent, in UTC, whatever the reader's calendar
  // and whatever zone the mail is opened in.
  const july = monthlyReceiptTemplate(
    receiptData({
      monthIso: "2026-07-01T00:00:00.000Z",
      billUsd: 8,
      meteredUsd: 8,
      ceilingUsd: 23,
      capped: false,
    }),
  );
  assert.match(july.subject, /July 2026, UTC$/);
  assert.match(july.text, /bill for July 2026, UTC is \$8\.00\./);
});

test("the receipt refuses a month that is not a month's first instant", () => {
  // The subject is built from this field, so a value that is not the first
  // instant of a UTC month is refused rather than rendered as a name nobody
  // billed: a day in the middle of a month, a moment in one, a month number
  // with no year, a hand-written month name, and nothing at all.
  for (const monthIso of [
    undefined,
    "October 2026",
    "2026-10-08T00:00:00.000Z",
    "2026-10-01T09:30:00.000Z",
    "2026-10-01",
    "2026-13-01T00:00:00.000Z",
    "2026-10-01T00:00:00.000+02:00",
  ]) {
    assert.throws(() => monthlyReceiptTemplate(receiptData({ monthIso })), TypeError);
  }
});

test("the receipt explains the bill is the capped meter", () => {
  // The one line that stops "why is my bill less than my usage" tickets:
  // the bill is min(metered, ceiling), and the ceiling is never charged.
  const { text } = monthlyReceiptTemplate(receiptData());
  assert.match(text, /min\(metered, ceiling\)/);
  assert.match(text, /never charged/);
});

test("the receipt never shows a per-minute price", () => {
  // build-spec.md: "Never advertise a per-minute price". The receipt is the
  // one mail a customer keeps and forwards to their accountant.
  const { text, html, subject } = monthlyReceiptTemplate(receiptData());
  for (const part of [subject, text, html]) {
    assert.doesNotMatch(part, /\$\s?[\d.,]+\s*(\/|per\s)\s*min/i);
  }
});

test("the receipt never says unlimited, credit or credits", () => {
  // build-spec.md "Never do": confusing credit units and "unlimited" plans.
  // The receipt is the one mail a customer keeps and forwards to their accountant.
  const { subject, text, html } = monthlyReceiptTemplate(receiptData());
  for (const part of [subject, text, html].map((s) => s.toLowerCase())) {
    for (const banned of ["unlimited", "credit", "credits"]) {
      assert.equal(part.includes(banned), false, `the receipt must not say "${banned}"`);
    }
  }
});

test("the two saved sentences are drive#39's, verbatim", () => {
  // Pinned so a copy change has to be a deliberate edit here too.
  assert.equal(SAVED_COPY.capped, "Our price cap saved you");
  assert.equal(SAVED_COPY.uncapped, "You paid");
  assert.equal(SAVED_COPY.uncappedSuffix, "less than a flat plan");
});

test("the rate constant is the spec's 2 cents per GB", () => {
  assert.equal(RATE_USD_PER_GB, 0.02);
});

// ---------------------------------------------------------------------------
// The Worker's own wiring: the route only works if the dispatcher hands the
// handler the whole env, and that is a mistake node --test's direct handler
// calls cannot catch (the in-run review found exactly that).
// ---------------------------------------------------------------------------

test("the Worker routes POST /api/emails/send to the send handler with env", async () => {
  // env, not env.EMAIL: the handler reads the token and the sending address.
  const { default: worker } = await import("../src/index.js");
  /** @type {(request: Request, env?: unknown) => Promise<Response>} */
  const workerFetch = /** @type {(request: Request, env?: unknown) => Promise<Response>} */ (
    /** @type {unknown} */ (worker.fetch)
  );
  const env = makeEnv({
    ASSETS: { fetch: async () => new Response("asset", { status: 200 }) },
  });
  const res = await workerFetch(
    postRequest(
      { to: "person@example.com", kind: "welcome" },
      { authorization: `Bearer ${TOKEN}` },
    ),
    env,
  );
  assert.equal(res.status, 202);
  assert.equal(env.EMAIL.sent.length, 1);
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.equal(body.messageId, "<fake@drive.example>");
});

test("the Worker refuses the send route without the token, and says so", async () => {
  // The gate that keeps the mounted route from being a mail relay.
  const { default: worker } = await import("../src/index.js");
  /** @type {(request: Request, env?: unknown) => Promise<Response>} */
  const workerFetch = /** @type {(request: Request, env?: unknown) => Promise<Response>} */ (
    /** @type {unknown} */ (worker.fetch)
  );
  const env = makeEnv({
    ASSETS: { fetch: async () => new Response("asset", { status: 200 }) },
  });
  const res = await workerFetch(postRequest({ to: "attacker@example.com", kind: "welcome" }), env);
  assert.equal(res.status, 403);
  assert.equal(env.EMAIL.sent.length, 0);
});

test("the Worker still serves the waitlist and the assets", async () => {
  // The new branch must not have displaced the existing routes.
  const { default: worker } = await import("../src/index.js");
  /** @type {(request: Request, env?: unknown) => Promise<Response>} */
  const workerFetch = /** @type {(request: Request, env?: unknown) => Promise<Response>} */ (
    /** @type {unknown} */ (worker.fetch)
  );
  const env = makeEnv({
    ASSETS: { fetch: async () => new Response("asset", { status: 200 }) },
    WAITLIST_DB: null,
  });
  const asset = await workerFetch(new Request("https://drive.example/"), env);
  assert.equal(asset.status, 200);
  assert.equal(await asset.text(), "asset");
  const waitlist = await workerFetch(
    new Request("https://drive.example/api/waitlist", { method: "GET" }),
    env,
  );
  assert.equal(waitlist.status, 405);
  // The library's own 405 names every method the path registers, minus the
  // implicit HEAD it adds, so the waitlist lane answers "POST" and nothing
  // else; `.includes` rather than `===` so a future method on the path is a
  // test edit and not a silent failure. Read once, so a missing header reads
  // as the message below rather than a null dereference.
  const allow = waitlist.headers.get("allow");
  assert.ok(allow?.includes("POST") === true, `allow header: ${allow}`);
});

// ---------------------------------------------------------------------------
// Rendering: unknown kinds, escaping, no shared mutation
// ---------------------------------------------------------------------------

test("an unknown kind throws rather than sending the wrong message", () => {
  // Includes the inherited Object.prototype names: a plain map lookup would
  // find "constructor" and render nothing.
  for (const kind of [
    "wlecome",
    "",
    null,
    undefined,
    "welcome ",
    "constructor",
    "toString",
    "hasOwnProperty",
    "__proto__",
    7,
  ]) {
    assert.throws(() => renderEmail(kind, {}), /Unknown email kind/);
  }
});

test("capped must be a real boolean, because it picks the saving's baseline", () => {
  // drive#39 gives two different sentences depending on this flag. A truthy
  // string would silently put the wrong one on a customer's receipt.
  for (const capped of [undefined, null, 1, "true", "", {}]) {
    assert.throws(
      () => savedLine({ meteredUsd: 16, billUsd: 12, ceilingUsd: 23, capped }),
      TypeError,
      `capped: ${String(capped)}`,
    );
    assert.throws(
      () => monthlyReceiptTemplate({ billUsd: 12, meteredUsd: 16, ceilingUsd: 23, capped }),
      TypeError,
      `capped: ${String(capped)}`,
    );
  }
});

test("a template cannot be corrupted through the caller's object", () => {
  // The renderer must not write into the data object it was handed, or one
  // caller's receipt could change another's.
  const data = receiptData();
  const copy = structuredClone(data);
  monthlyReceiptTemplate(data);
  assert.deepEqual(data, copy);
});

test("the HTML part carries no unescaped caller value", () => {
  // Every interpolated value is a validated number rendered by usd() (digits,
  // a dot, a leading $) or fixed prose, so no template needs a hand-rolled
  // HTML escape -- which is also why semgrep's replaceAll-sanitization rule
  // has nothing to flag. If a future template interpolates a string (a
  // filename, an address), it must bring a real sanitizer, and this test is
  // where that shows up.
  for (const kind of EMAIL_KINDS) {
    const { html } = renderEmail(kind, dataFor(kind));
    assert.equal(/<script|javascript:|onerror=|onload=/i.test(html), false, `${kind} html`);
  }
});

test("every interpolated value is a validated number or fixed prose", () => {
  // The templates only ever splice usd() output or a constant sentence into
  // the markup; a caller cannot smuggle markup through the data object.
  const { html } = paymentFailedTemplate({ amountUsd: 1 });
  assert.match(html, /\$1\.00/);
  // The data object's string fields are never concatenated into html: passing
  // one changes nothing in the output.
  const injected = monthlyReceiptTemplate({ ...receiptData(), note: "<img onerror=alert(1)>" });
  assert.equal(injected.html.includes("<img"), false);
});

// ---------------------------------------------------------------------------
// The send lane
// ---------------------------------------------------------------------------

test("sendEmail hands the rendered message to the binding", async () => {
  const email = makeFakeEmail({ messageId: "<abc@drive.example>" });
  const sent = await sendEmail(email, {
    to: "  person@example.com  ",
    from: MAIL_FROM,
    kind: "welcome",
  });
  assert.equal(sent.messageId, "<abc@drive.example>");
  assert.equal(sent.subject, "Your drive is ready");
  // One message, to the trimmed address, from the declared sender, with both
  // parts and the rendered subject.
  assert.equal(email.sent.length, 1);
  assert.deepEqual(email.sent[0], {
    to: "person@example.com",
    from: { email: MAIL_FROM, name: FROM_NAME },
    subject: "Your drive is ready",
    text: welcomeTemplate().text,
    html: welcomeTemplate().html,
  });
});

test("sendEmail throws when the binding is missing or wrong", async () => {
  for (const binding of [null, undefined, {}, { send: "nope" }]) {
    await assert.rejects(
      sendEmail(binding, { to: "person@example.com", from: MAIL_FROM, kind: "welcome" }),
      /EMAIL is not bound/,
    );
  }
});

test("sendEmail refuses an empty recipient and an unknown kind", async () => {
  const email = makeFakeEmail();
  for (const request of [
    { to: "", from: MAIL_FROM, kind: "welcome" },
    { to: "   ", from: MAIL_FROM, kind: "welcome" },
    { to: 42, from: MAIL_FROM, kind: "welcome" },
    { to: "person@example.com", from: MAIL_FROM, kind: "nope" },
    { to: "person@example.com", kind: "welcome" },
  ]) {
    await assert.rejects(sendEmail(email, request), (error) => {
      assert.ok(
        error instanceof TypeError ||
          (error instanceof Error && /Unknown email kind/.test(error.message)),
      );
      return true;
    });
  }
  assert.equal(email.sent.length, 0, "nothing goes out on a rejected request");
});

test("a provider failure is raised, never reported as sent", async () => {
  // The one lie this lane must not tell: "sent" for a message nobody got.
  const email = makeFakeEmail(new Error("E_SENDER_NOT_VERIFIED"));
  await assert.rejects(
    sendEmail(email, { to: "person@example.com", from: MAIL_FROM, kind: "welcome" }),
    /E_SENDER_NOT_VERIFIED/,
  );
});

test("a send with no message id is a failure, not a success", async () => {
  // No id means no safe retry: the meter's "once per month" decision and the
  // billing webhook's retry both need it. An empty or whitespace id is the
  // same failure as a missing one.
  for (const result of [null, {}, { messageId: 42 }, { messageId: "" }, { messageId: "   " }]) {
    const email = makeFakeEmail(result);
    await assert.rejects(
      sendEmail(email, { to: "person@example.com", from: MAIL_FROM, kind: "welcome" }),
      /no message id/,
    );
  }
});

// ---------------------------------------------------------------------------
// The route
// ---------------------------------------------------------------------------

test("the route sends an authorised request", async () => {
  const env = makeEnv();
  const res = await handleSendEmailRequest(
    authed({ to: "person@example.com", kind: "monthly-receipt", data: receiptData() }),
    env,
  );
  assert.equal(res.status, 202);
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.equal(body.kind, "monthly-receipt");
  assert.equal(body.to, "person@example.com");
  assert.equal(typeof body.messageId, "string");
  assert.equal(env.EMAIL.sent.length, 1);
});

test("the route refuses a request with no token", async () => {
  // A route anyone can POST to is a way to mail an arbitrary person from our
  // domain, so a missing token is a 403 and not a send.
  const env = makeEnv();
  const res = await handleSendEmailRequest(
    postRequest({ to: "attacker@example.com", kind: "welcome" }),
    env,
  );
  assert.equal(res.status, 403);
  assert.equal(env.EMAIL.sent.length, 0);
});

test("the route refuses a wrong token, a wrong scheme and a token prefix", async () => {
  const env = makeEnv();
  const cases = [
    `Bearer ${TOKEN}x`,
    `Bearer ${TOKEN.slice(0, -1)}`,
    TOKEN,
    `Basic ${TOKEN}`,
    `Bearer`,
  ];
  for (const authorization of cases) {
    const res = await handleSendEmailRequest(
      postRequest({ to: "attacker@example.com", kind: "welcome" }, { authorization }),
      env,
    );
    assert.equal(res.status, 403, `authorization: ${authorization}`);
  }
  assert.equal(env.EMAIL.sent.length, 0);
});

test("a deployment with no send token sends nothing at all", async () => {
  // The secret is unset on a fresh deployment: closed door, not open one.
  const env = makeEnv({ EMAIL_SEND_TOKEN: "" });
  const res = await handleSendEmailRequest(
    postRequest(
      { to: "person@example.com", kind: "welcome" },
      { authorization: `Bearer ${TOKEN}` },
    ),
    env,
  );
  assert.equal(res.status, 403);
  assert.equal(env.EMAIL.sent.length, 0);
  assert.equal(isAuthorizedSend(postRequest({}), undefined), false);
  assert.equal(isAuthorizedSend(postRequest({}), ""), false);
});

test("the route refuses a cross-site request even with the token", async () => {
  const env = makeEnv();
  const res = await handleSendEmailRequest(
    authed({ to: "attacker@example.com", kind: "welcome" }, { origin: "https://evil.example" }),
    env,
  );
  assert.equal(res.status, 403);
  assert.equal(env.EMAIL.sent.length, 0);
});

test("the same-origin rule matches the waitlist API's", () => {
  // One rule in the repo, not two: src/waitlist.js has the first one.
  const own = new Request("https://drive.example/api/emails/send", {
    headers: { origin: "https://drive.example" },
  });
  assert.equal(isSameOriginRequest(own), true);
  assert.equal(isSameOriginRequest(new Request("https://drive.example/api/emails/send")), true);
  assert.equal(
    isSameOriginRequest(
      new Request("https://drive.example/api/emails/send", {
        headers: { origin: "https://drive.example.evil.example" },
      }),
    ),
    false,
  );
});

test("a same-origin form POST with Origin: null is accepted, a cross-site one is not", () => {
  // Referrer-Policy: no-referrer makes Chromium send `Origin: null` on the
  // device approve form; Sec-Fetch-Site says whether it was really ours.
  const url = "https://drive.example/v1/device/approve";
  const form = (/** @type {string} */ site) =>
    new Request(url, { method: "POST", headers: { origin: "null", "sec-fetch-site": site } });
  assert.equal(isSameOriginRequest(form("same-origin")), true);
  assert.equal(isSameOriginRequest(form("cross-site")), false);
  assert.equal(isSameOriginRequest(form("same-site")), false);
  assert.equal(
    isSameOriginRequest(new Request(url, { method: "POST", headers: { origin: "null" } })),
    false,
  );
});

test("the route names the one method it serves", async () => {
  const res = await handleSendEmailRequest(
    new Request("https://drive.example/api/emails/send", { method: "GET" }),
    makeEnv(),
  );
  assert.equal(res.status, 405);
  assert.equal(res.headers.get("allow"), "POST");
});

test("the route rejects a body that is not JSON", async () => {
  const res = await handleSendEmailRequest(authed("not json at all"), makeEnv());
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /not valid JSON/);
});

test("the route answers a JSON null body with a 400, not a Worker 500", async () => {
  // readRequest used to destructure null and throw out of the handler, which
  // a Worker turns into an opaque 500. Every non-object JSON body is a named
  // 400 now: null and scalars get the object message, an array gets the
  // kinds message.
  for (const body of ["null", "[]", '"a string"', "42", "true"]) {
    const res = await handleSendEmailRequest(authed(body), makeEnv());
    assert.equal(res.status, 400, `body: ${body}`);
    assert.match((await res.json()).error, /Send a JSON object|Send one of these emails/);
  }
});

test("a body the template cannot be built from is a 400, not a 502", async () => {
  // A deterministic caller error must not look like a retryable provider
  // failure: the billing webhook would retry a missing amount forever.
  const env = makeEnv();
  for (const [kind, data] of [
    ["monthly-receipt", { billUsd: 12 }], // no meter, ceiling or capped
    ["cap-warning", {}], // no cap
    ["read-only", {}], // no cap
    ["payment-failed", {}], // no amount
    ["account-closed", {}], // no grace window
    ["account-close-reminder", { graceDays: 30 }], // no reminder or date
  ]) {
    const res = await handleSendEmailRequest(authed({ to: "person@example.com", kind, data }), env);
    assert.equal(res.status, 400, `kind: ${kind}`);
    assert.match((await res.json()).error, new RegExp(`Cannot build the ${kind}`));
  }
  assert.equal(env.EMAIL.sent.length, 0, "nothing is sent for a 400");
});

test("a receipt with no month, no saving and no capped flag is a 400", async () => {
  // The one output this lane must never produce: a receipt that names no
  // month, or a $0 bill that hides a lost meter number.
  const res = await handleSendEmailRequest(
    authed({
      to: "person@example.com",
      kind: "monthly-receipt",
      data: {
        billUsd: 12,
        meteredUsd: 16,
        ceilingUsd: 12,
        // A month with no month in it is refused on the month, before the
        // capped flag: a receipt that names no month is not a receipt, even
        // when the rest of its month is real (drive#559).
        capped: true,
      },
    }),
    makeEnv(),
  );
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /monthIso must be a month's first instant/);
});

test("the route names the five kinds when the kind is wrong", async () => {
  for (const kind of ["nope", 7, null, "", "constructor", "toString"]) {
    const res = await handleSendEmailRequest(authed({ to: "person@example.com", kind }), makeEnv());
    assert.equal(res.status, 400, `kind: ${kind}`);
    const { error } = await res.json();
    for (const known of EMAIL_KINDS) {
      assert.ok(error.includes(known), `the error names ${known}`);
    }
  }
});

test("the route needs a recipient address", async () => {
  for (const to of ["", "   ", 42, null]) {
    const res = await handleSendEmailRequest(authed({ to, kind: "welcome" }), makeEnv());
    assert.equal(res.status, 400, `to: ${to}`);
    assert.match((await res.json()).error, /email address is required/);
  }
});

test("a deployment with no MAIL_FROM says so, and sends nothing", async () => {
  // The sending address is a deployment setting. A missing one is closed and
  // named, never a placeholder domain that silently fails every send.
  const env = makeEnv({ MAIL_FROM: undefined });
  for (const mailFrom of [undefined, "", "   "]) {
    const res = await handleSendEmailRequest(
      authed({ to: "person@example.com", kind: "welcome" }),
      makeEnv({ MAIL_FROM: mailFrom }),
    );
    assert.equal(res.status, 503, `MAIL_FROM: ${mailFrom}`);
    assert.match((await res.json()).error, /MAIL_FROM is not set/);
  }
  assert.equal(env.EMAIL.sent.length, 0);
});

test("a deployment with no EMAIL binding says so, and sends nothing", async () => {
  const res = await handleSendEmailRequest(
    authed({ to: "person@example.com", kind: "welcome" }),
    makeEnv({ EMAIL: null }),
  );
  assert.equal(res.status, 503);
  assert.match((await res.json()).error, /EMAIL is not bound/);
});

test("a provider failure is a 502 naming the provider's own error", async () => {
  // The route names the failure instead of returning a 202 for a message that
  // was never accepted.
  const env = makeEnv({ EMAIL: makeFakeEmail(new Error("E_RATE_LIMIT")) });
  const res = await handleSendEmailRequest(
    authed({ to: "person@example.com", kind: "welcome" }),
    env,
  );
  assert.equal(res.status, 502);
  const { error } = await res.json();
  assert.match(error, /E_RATE_LIMIT/);
  assert.match(error, /welcome/);
});

test("the route sends each of the five kinds through the one lane", async () => {
  // One send path, exercised by all five templates, so a template that only
  // works when called directly cannot ship.
  for (const kind of EMAIL_KINDS) {
    const env = makeEnv();
    const res = await handleSendEmailRequest(
      authed({ to: "person@example.com", kind, data: dataFor(kind) }),
      env,
    );
    assert.equal(res.status, 202, `kind: ${kind}`);
    assert.equal(env.EMAIL.sent.length, 1, `kind: ${kind}`);
    const message = /** @type {{from: {email: string}, text: string, html: string}} */ (
      env.EMAIL.sent[0]
    );
    assert.equal(message.from.email, MAIL_FROM);
    assert.ok(message.text.includes("-- Drive"), `kind: ${kind} text sign-off`);
    assert.ok(message.html.includes("-- Drive"), `kind: ${kind} html sign-off`);
  }
});

// ---------------------------------------------------------------------------
// 8) top-up receipt and 9) low balance (drive#586)
// ---------------------------------------------------------------------------

test("a top-up receipt names the money added and the balance it left", () => {
  const manual = renderEmail("top-up-receipt", { amountUsd: 25, balanceUsd: 31.5, auto: false });
  assert.equal(manual.subject, "Your Drive receipt: $25.00 added");
  assert.match(manual.text, /You added \$25\.00/);
  assert.match(manual.text, /balance is now \$31\.50\. It never expires\./);
  const auto = renderEmail("top-up-receipt", { amountUsd: 10, balanceUsd: 11.2, auto: true });
  assert.match(auto.text, /^Auto top-up added \$10\.00/);
  assert.throws(() => renderEmail("top-up-receipt", { amountUsd: 10, balanceUsd: 1 }), /auto/);
  assert.throws(() => renderEmail("top-up-receipt", { balanceUsd: 1, auto: false }), /amountUsd/);
});

test("the low-balance email says what happens at $0, or that auto top-up covers it", () => {
  const off = renderEmail("low-balance", { balanceUsd: 1.8, autoTopUpUsd: null });
  assert.equal(off.subject, "Your Drive balance is $1.80");
  assert.match(off.text, /Top up to keep adding files\./);
  assert.match(off.text, /nothing is deleted/);
  const on = renderEmail("low-balance", { balanceUsd: 1.8, autoTopUpUsd: 25 });
  assert.match(on.text, /Auto top-up is on, so \$25\.00 will be added/);
});
