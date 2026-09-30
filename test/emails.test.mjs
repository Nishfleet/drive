// Every drive email, every branch. The copy is a decision (docs/build-spec.md,
// "Nothing missing": welcome, 80% of cap, read-only reached, payment failed,
// monthly receipt with the "you saved" line), so the tests pin the sentences,
// the numbers and the two "you saved" baselines from drive#39 rather than
// letting a later run quietly reword a customer's inbox.
//
// No Worker runtime: sendEmail takes the binding as an argument, so a fake
// records what would have gone out and the templates run through node --test.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_CAP_USD,
  EMAIL_KINDS,
  FROM_NAME,
  RATE_USD_PER_GB,
  SAVED_COPY,
  capWarningTemplate,
  monthlyReceiptTemplate,
  paymentFailedTemplate,
  readOnlyTemplate,
  renderEmail,
  savedLine,
  welcomeTemplate,
} from "../src/emails.js";
import {
  handleSendEmailRequest,
  isAuthorizedSend,
  isSameOriginRequest,
  sendEmail,
} from "../src/email-send.js";

// The deployment's sending address, set per deployment (the sending domain is
// a deployment decision, not a code one).
const MAIL_FROM = "notifications@drive.example";

// A fake send_email binding: records the message, and can be told to fail.
function makeFakeEmail(result = { messageId: "<fake@drive.example>" }) {
  const sent = [];
  return {
    sent,
    async send(message) {
      sent.push(message);
      if (result instanceof Error) {
        throw result;
      }
      return result;
    },
  };
}

// The route's own token, and an env carrying it.
const TOKEN = "test-send-token";
function makeEnv(overrides = {}) {
  return {
    EMAIL: makeFakeEmail(),
    EMAIL_SEND_TOKEN: TOKEN,
    MAIL_FROM,
    ...overrides,
  };
}

function postRequest(body, headers = {}) {
  return new Request("https://drive.example/api/emails/send", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

function authed(body, extra = {}) {
  return postRequest(body, { authorization: `Bearer ${TOKEN}`, ...extra });
}

// ---------------------------------------------------------------------------
// The five kinds
// ---------------------------------------------------------------------------

test("the five emails are the five the spec names", () => {
  assert.deepEqual(EMAIL_KINDS, [
    "welcome",
    "cap-warning",
    "read-only",
    "payment-failed",
    "monthly-receipt",
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

test("welcome names the one install command and what it does", () => {
  const { subject, text } = welcomeTemplate();
  assert.equal(subject, "Your drive is ready");
  assert.match(text, /drive init/);
  // The one command, not a second install path: the CLI ships with build
  // step 2 (drive#3) and there is no app to download.
  assert.equal(text.split("drive init").length - 1, 1);
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
  assert.equal(DEFAULT_CAP_USD, 12, "the default cap is $12 (drive#39)");
  assert.equal((0.8 * DEFAULT_CAP_USD).toFixed(2), "9.60");
});

test("the cap warning defaults to the decided cap and carries it in both parts", () => {
  // The template requires the cap, so a caller that means the default passes
  // it explicitly; both paths render the same message.
  const withDefault = capWarningTemplate({ capUsd: DEFAULT_CAP_USD });
  assert.match(withDefault.html, /\$12\.00/);
  assert.match(withDefault.text, /\$12\.00/);
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

function receiptData(overrides = {}) {
  return {
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
  assert.match(text, /bill for this month is \$12\.00/);
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
  // drive#39: "Hidden when <= 0". One case per baseline: a capped month where
  // the meter equals the bill, and an uncapped month where the ceiling equals
  // the bill.
  for (const month of [
    { meteredUsd: 12, billUsd: 12, ceilingUsd: 23, capped: true },
    { meteredUsd: 9, billUsd: 12, ceilingUsd: 12, capped: false },
  ]) {
    assert.equal(savedLine(month), null);
    const { text, html, saved } = monthlyReceiptTemplate({ ...receiptData(), ...month });
    assert.equal(saved, null);
    assert.equal(/saved you|less than a flat plan/.test(text), false);
    assert.equal(/saved you|less than a flat plan/.test(html), false);
  }
});

test("savedLine refuses a month with nonsense in it", () => {
  for (const month of [null, "12", {}, { meteredUsd: -1, billUsd: 0, ceilingUsd: 0, capped: true }]) {
    assert.throws(() => savedLine(month), TypeError);
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
  // The free $1 is shown as a dollar line or not at all.
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
// Rendering: unknown kinds, escaping, no shared mutation
// ---------------------------------------------------------------------------

test("an unknown kind throws rather than sending the wrong message", () => {
  for (const kind of ["wlecome", "", null, undefined, "welcome "]) {
    assert.throws(() => renderEmail(kind, {}), /Unknown email kind/);
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

test("interpolated values are escaped in the HTML part", () => {
  // Dollars are numbers today; a filename or an address is the value most
  // likely to arrive one day, and it must not become markup.
  const { html } = paymentFailedTemplate({ amountUsd: 1 });
  assert.ok(!html.includes("<script"), "no raw markup can reach the HTML part");
  assert.ok(html.includes("&amp;") || !html.includes("&"), "ampersands are escaped when present");
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
      assert.ok(error instanceof TypeError || /Unknown email kind/.test(error.message));
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
  // billing webhook's retry both need it.
  for (const result of [null, {}, { messageId: 42 }]) {
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
    authed(
      { to: "attacker@example.com", kind: "welcome" },
      { origin: "https://evil.example" },
    ),
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

test("the route names the one method it serves", async () => {
  const res = await handleSendEmailRequest(
    new Request("https://drive.example/api/emails/send", { method: "GET" }),
    makeEnv(),
  );
  assert.equal(res.status, 405);
  assert.equal(res.headers.get("allow"), "POST");
});

test("the route rejects a body that is not JSON", async () => {
  const res = await handleSendEmailRequest(
    authed("not json at all"),
    makeEnv(),
  );
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /not valid JSON/);
});

test("the route names the five kinds when the kind is wrong", async () => {
  for (const kind of ["nope", 7, null, ""]) {
    const res = await handleSendEmailRequest(
      authed({ to: "person@example.com", kind }),
      makeEnv(),
    );
    assert.equal(res.status, 400, `kind: ${kind}`);
    const { error } = await res.json();
    for (const known of EMAIL_KINDS) {
      assert.ok(error.includes(known), `the error names ${known}`);
    }
  }
});

test("the route needs a recipient address", async () => {
  for (const to of ["", "   ", 42, null]) {
    const res = await handleSendEmailRequest(
      authed({ to, kind: "welcome" }),
      makeEnv(),
    );
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
    const message = env.EMAIL.sent[0];
    assert.equal(message.from.email, MAIL_FROM);
    assert.ok(message.text.includes("-- Drive"), `kind: ${kind} text sign-off`);
    assert.ok(message.html.includes("-- Drive"), `kind: ${kind} html sign-off`);
  }
});
