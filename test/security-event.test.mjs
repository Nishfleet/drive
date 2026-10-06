// Security-event mail (drive#551): one template, one send per event, a mail
// failure does not fail the action, and the usage page shows open public links.

import assert from "node:assert/strict";
import { test } from "node:test";
import { AUTH_COOKIE_PREFIX } from "../core/auth.js";
import { handleUsageRequest } from "../core/billing.js";
import { handleCapRequest } from "../core/cap.js";
import { renderEmail, SECURITY_EVENT_COPY } from "../core/emails.js";
import {
  createMemoryStore as createFileStore,
  FILES_ENDPOINT,
  handleFilesRequest,
} from "../core/files.js";
import { createMemoryStore } from "../core/keystore.js";
import { mailFromEnv, notifySecurityEvent, sessionLabel } from "../core/security-event.js";
import { createD1LinkStore, handleRequestRequest, handleShareRequest } from "../src/share.js";
import { dispatch } from "../workers/api/src/index.js";
import { mintTeamKeyRoute } from "../workers/api/src/team-routes.js";
import { createTestD1 } from "./harness.mjs";

const MAIL_FROM = "drive@example.com";
const REPLY_TO = "support@example.com";
const HAPPENED_AT = "2026-10-06T09:00:00.000Z";
const SESSION_COOKIE = `__Secure-${AUTH_COOKIE_PREFIX}.session_token`;
const MONTH_ISO = "2026-10-01T00:00:00.000Z";

/**
 * @param {Error | {messageId?: string}|null} [result]
 */
function fakeEmail(result = { messageId: "mid_1" }) {
  /** @type {unknown[]} */
  const sent = [];
  return {
    sent,
    /** @param {unknown} message */
    async send(message) {
      sent.push(message);
      if (result instanceof Error) {
        throw result;
      }
      return /** @type {{messageId: string}} */ (result);
    },
  };
}

test("each security event renders one mail with the device name and a revoke link", () => {
  for (const event of Object.keys(SECURITY_EVENT_COPY)) {
    const rendered = renderEmail("security-event", {
      event,
      deviceName: "office laptop",
      happenedAt: HAPPENED_AT,
      replyTo: REPLY_TO,
    });
    assert.match(rendered.subject, /security event/i, event);
    assert.match(rendered.text, /office laptop/, event);
    assert.match(rendered.text, new RegExp(HAPPENED_AT.replaceAll(".", "\\.")), event);
    assert.match(rendered.text, /Revoke access on the usage page/, event);
    assert.match(rendered.text, /https:\/\/[^ ]*usage\.html/, event);
    assert.match(rendered.html, /office laptop/, event);
    assert.match(rendered.html, /href="https:\/\/[^"]*usage\.html"/, event);
    assert.equal(rendered.text.split("-- Drive").length - 1, 1, event);
  }
});

test("a hostile device name cannot break the HTML part", () => {
  const rendered = renderEmail("security-event", {
    event: "share-link-created",
    deviceName: `<img onerror="alert(1)">`,
    happenedAt: HAPPENED_AT,
    replyTo: REPLY_TO,
  });
  assert.equal(rendered.html.includes("<img"), false);
  assert.match(rendered.html, /&lt;img/);
});

test("notifySecurityEvent sends exactly one mail, and a failure does not throw", async () => {
  const ok = fakeEmail();
  const sent = await notifySecurityEvent({
    email: ok,
    mailFrom: MAIL_FROM,
    to: "you@example.com",
    event: "agent-key-minted",
    deviceName: "office laptop",
    happenedAt: HAPPENED_AT,
  });
  assert.deepEqual(sent, { sent: true, reason: "sent" });
  assert.equal(ok.sent.length, 1);
  const message = /** @type {{to: string, subject: string, text: string}} */ (ok.sent[0]);
  assert.equal(message.to, "you@example.com");
  assert.match(message.subject, /security event/i);
  assert.match(message.text, /office laptop/);
  assert.match(message.text, /An agent key was minted/);

  const down = fakeEmail(new Error("vendor down"));
  const failed = await notifySecurityEvent({
    email: down,
    mailFrom: MAIL_FROM,
    to: "you@example.com",
    event: "cap-changed",
    deviceName: "office laptop",
    happenedAt: HAPPENED_AT,
    log() {},
  });
  assert.deepEqual(failed, { sent: false, reason: "send-failed" });
  assert.equal(down.sent.length, 1);

  const skipped = await notifySecurityEvent({
    event: "device-logged-out",
    to: "you@example.com",
  });
  assert.deepEqual(skipped, { sent: false, reason: "no-email-binding" });
});

test("a missing device name falls back to a signed-in device", async () => {
  const ok = fakeEmail();
  await notifySecurityEvent({
    email: ok,
    mailFrom: MAIL_FROM,
    to: "you@example.com",
    event: "device-logged-out",
    happenedAt: HAPPENED_AT,
  });
  assert.match(String(/** @type {{text: string}} */ (ok.sent[0]).text), /a signed-in device/);
});

test("a hanging mailer does not hold the action past the deadline", async () => {
  /** @type {(value: {messageId: string}) => void} */
  let release = () => {};
  const hanging = {
    /**
     * @param {unknown} _message
     * @returns {Promise<{messageId: string}>}
     */
    send(_message) {
      return new Promise((resolve) => {
        release = resolve;
      });
    },
  };
  const started = Date.now();
  const result = await notifySecurityEvent({
    email: hanging,
    mailFrom: MAIL_FROM,
    to: "you@example.com",
    event: "agent-key-minted",
    deadlineMs: 40,
  });
  const elapsed = Date.now() - started;
  release({ messageId: "late" });
  assert.deepEqual(result, { sent: false, reason: "send-failed" });
  assert.ok(elapsed < 1000, `hung ${elapsed}ms`);
});

test("sessionLabel names the web app or the CLI from the Origin header", () => {
  assert.equal(
    sessionLabel(
      new Request("https://drive.test/api/share", {
        method: "POST",
        headers: { origin: "https://drive.test" },
      }),
    ),
    "the web app",
  );
  assert.equal(
    sessionLabel(new Request("https://drive.test/api/share", { method: "POST" })),
    "the drive CLI",
  );
});

test("mailFromEnv reads EMAIL and MAIL_FROM off a Worker env", () => {
  assert.deepEqual(mailFromEnv(null), { email: undefined, mailFrom: "" });
  const email = fakeEmail();
  assert.deepEqual(mailFromEnv({ EMAIL: email, MAIL_FROM }), { email, mailFrom: MAIL_FROM });
});

test("minting a share or upload-request link sends one mail, and a failure still mints", async () => {
  const files = createFileStore();
  const links = createD1LinkStore(createTestD1());
  const account = { id: "acct-1", name: "You", email: "you@example.com" };
  const now = Date.parse(HAPPENED_AT);
  const uploaded = await handleFilesRequest(
    new Request(
      `https://drive.test${FILES_ENDPOINT}/upload?path=${encodeURIComponent("/")}&name=${encodeURIComponent("holiday.jpg")}`,
      { method: "POST", headers: { "content-type": "image/jpeg" }, body: "jpeg bytes" },
    ),
    files,
    account,
    now,
  );
  assert.equal(uploaded.status, 201);

  const shareMail = fakeEmail();
  const shared = await handleShareRequest(
    new Request("https://drive.test/api/share", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: "/holiday.jpg" }),
    }),
    files,
    links,
    account,
    {
      now,
      token: "AAAAAAAAAAAAAAAAAAAAAA",
      limiter: {
        async limit() {
          return { success: true };
        },
      },
      email: shareMail,
      mailFrom: MAIL_FROM,
      deviceName: "office laptop",
    },
  );
  assert.equal(shared.status, 201);
  assert.equal(shareMail.sent.length, 1);
  assert.match(String(/** @type {{text: string}} */ (shareMail.sent[0]).text), /share link/);
  assert.match(String(/** @type {{text: string}} */ (shareMail.sent[0]).text), /office laptop/);

  const browserReq = new Request("https://drive.test/api/share", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: "https://drive.test",
    },
    body: JSON.stringify({ path: "/holiday.jpg" }),
  });
  const browserMail = fakeEmail();
  const fromBrowser = await handleShareRequest(browserReq, files, links, account, {
    now,
    token: "CCCCCCCCCCCCCCCCCCCCCC",
    limiter: {
      async limit() {
        return { success: true };
      },
    },
    email: browserMail,
    mailFrom: MAIL_FROM,
    deviceName: sessionLabel(browserReq),
  });
  assert.equal(fromBrowser.status, 201);
  assert.match(String(/** @type {{text: string}} */ (browserMail.sent[0]).text), /the web app/);

  const requestMail = fakeEmail(new Error("vendor down"));
  const requested = await handleRequestRequest(
    new Request("https://drive.test/api/request", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ folder: "/" }),
    }),
    files,
    links,
    account,
    {
      now,
      token: "BBBBBBBBBBBBBBBBBBBBBB",
      limiter: {
        async limit() {
          return { success: true };
        },
      },
      email: requestMail,
      mailFrom: MAIL_FROM,
      deviceName: "office laptop",
    },
  );
  assert.equal(requested.status, 201, "a mail failure does not fail the mint");
  assert.equal(requestMail.sent.length, 1);
});

test("changing the cap sends one mail, and a failure still saves the cap", async () => {
  /** @type {number[]} */
  const stored = [];
  const capStore = {
    /**
     * @param {unknown} _account
     * @param {number} cents
     */
    async setCapCents(_account, cents) {
      stored.push(cents);
    },
    async listCapKeys() {
      return [];
    },
    keyProviderFor() {
      return {
        async mint() {
          return { accessKeyId: "AKIA", secret: "s", sessionToken: null };
        },
        async revoke() {},
        async swapToReadOnly() {
          return { accessKeyId: "AKIA", secret: "s", sessionToken: null };
        },
      };
    },
    async setAccountState() {},
  };
  const down = fakeEmail(new Error("vendor down"));
  const ok = await handleCapRequest(
    new Request("https://drive.test/api/cap", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ amount: "20" }),
    }),
    { id: "acct-1", name: "You", email: "you@example.com" },
    capStore,
    { email: down, mailFrom: MAIL_FROM, deviceName: "office laptop" },
  );
  assert.equal(ok.status, 200, "a mail failure does not fail the cap write");
  assert.equal(stored[0], 2000);
  assert.equal(down.sent.length, 1);
  assert.match(String(/** @type {{text: string}} */ (down.sent[0]).text), /spending cap/);
  assert.match(String(/** @type {{text: string}} */ (down.sent[0]).text), /\$20\.00/);

  const same = fakeEmail();
  const again = await handleCapRequest(
    new Request("https://drive.test/api/cap", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ amount: "20" }),
    }),
    { id: "acct-1", name: "You", email: "you@example.com", capUsd: 20 },
    capStore,
    { email: same, mailFrom: MAIL_FROM, deviceName: "office laptop" },
  );
  assert.equal(again.status, 200);
  assert.equal(same.sent.length, 0, "a no-op cap write does not mail");
});

test("the usage answer carries the open public link count", async () => {
  const body = await handleUsageRequest(
    new Request("https://drive.test/api/usage"),
    { id: "acct-1", name: "You", openPublicLinks: 2 },
    null,
    null,
    MONTH_ISO,
  ).json();
  assert.equal(body.openPublicLinks, 2);
});

function makeAccounts() {
  /** @type {Map<string, {id: string, name: string, email: string}>} */
  const byToken = new Map();
  let next = 0;
  return {
    /**
     * @param {{id: string, name: string, email: string}} account
     */
    add(account) {
      const token = `sess_${++next}`;
      byToken.set(token, account);
      return token;
    },
    api: {
      /**
       * @param {{headers: Headers}} options
       */
      async getSession({ headers }) {
        const cookie = headers.get("cookie") ?? "";
        const found = cookie
          .split(";")
          .map((/** @type {string} */ part) => part.trim())
          .find((/** @type {string} */ part) => part.startsWith(`${SESSION_COOKIE}=`));
        const token = found?.slice(SESSION_COOKIE.length + 1);
        const account = token === undefined ? undefined : byToken.get(token);
        return account === undefined ? null : { user: account };
      },
    },
  };
}

function limits() {
  const pass = {
    async limit() {
      return { success: true };
    },
  };
  return { DEVICE_RATE_LIMITER: pass, DEVICE_GLOBAL_RATE_LIMITER: pass };
}

/**
 * @param {ReturnType<typeof createMemoryStore>} store
 * @param {ReturnType<typeof fakeEmail>|undefined} email
 * @param {string} [mailFrom]
 */
function baseCtx(store, email, mailFrom = MAIL_FROM) {
  return {
    env: { ...limits(), EMAIL: email, MAIL_FROM: mailFrom },
    db: null,
    store,
    now: () => Date.parse(HAPPENED_AT),
  };
}

/**
 * @param {ReturnType<typeof createMemoryStore>} store
 * @param {string} name
 * @param {ReturnType<typeof fakeEmail>} emailBinding
 */
async function signIn(store, name, emailBinding) {
  const accounts = makeAccounts();
  const account = {
    id: `acct_${name.replace(/\W+/g, "_")}`,
    name,
    email: `${name.replace(/\W+/g, "_")}@example.com`,
  };
  const sessionToken = accounts.add(account);
  const ctx = {
    ...baseCtx(store, emailBinding),
    accounts,
  };
  const codeRes = await dispatch(
    new Request("https://api.test/v1/device/code", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name }),
    }),
    ctx,
  );
  assert.equal(codeRes.status, 200);
  const code = await codeRes.json();
  const approved = await dispatch(
    new Request("https://api.test/v1/device/approve", {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        cookie: `${SESSION_COOKIE}=${sessionToken}`,
      },
      body: `user_code=${encodeURIComponent(code.userCode)}`,
    }),
    ctx,
  );
  assert.equal(approved.status, 200);
  const tokenRes = await dispatch(
    new Request("https://api.test/v1/device/token", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ device_code: code.deviceCode }),
    }),
    ctx,
  );
  assert.equal(tokenRes.status, 200);
  const token = await tokenRes.json();
  return { account: token.account, deviceToken: token.deviceToken, ctx };
}

test("minting an agent or branch key sends one mail; a device key sends none", async () => {
  const store = createMemoryStore({ now: () => Date.parse(HAPPENED_AT) });
  const mail = fakeEmail();
  const { deviceToken, ctx } = await signIn(store, "office laptop", mail);
  mail.sent.length = 0;

  const agent = await dispatch(
    new Request("https://api.test/v1/keys", {
      method: "POST",
      headers: {
        authorization: `Bearer ${deviceToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ kind: "agent", name: "claude" }),
    }),
    ctx,
  );
  assert.equal(agent.status, 201);
  assert.equal(mail.sent.length, 1);
  assert.match(String(/** @type {{text: string}} */ (mail.sent[0]).text), /agent key/);
  assert.match(String(/** @type {{text: string}} */ (mail.sent[0]).text), /claude/);

  mail.sent.length = 0;
  const branch = await dispatch(
    new Request("https://api.test/v1/keys", {
      method: "POST",
      headers: {
        authorization: `Bearer ${deviceToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ kind: "branch", name: "fix-login" }),
    }),
    ctx,
  );
  assert.equal(branch.status, 201);
  assert.equal(mail.sent.length, 1);
  assert.match(String(/** @type {{text: string}} */ (mail.sent[0]).text), /branch key/);

  mail.sent.length = 0;
  const device = await dispatch(
    new Request("https://api.test/v1/keys", {
      method: "POST",
      headers: {
        authorization: `Bearer ${deviceToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ kind: "device", name: "this-mac" }),
    }),
    ctx,
  );
  assert.equal(device.status, 201);
  assert.equal(mail.sent.length, 0, "a person's own device key is not a security event");
});

test("a mailer that refuses still mints the agent key", async () => {
  const store = createMemoryStore({ now: () => Date.parse(HAPPENED_AT) });
  const working = fakeEmail();
  const { deviceToken, ctx } = await signIn(store, "office laptop", working);
  const mail = fakeEmail(new Error("vendor down"));
  ctx.env.EMAIL = mail;
  const minted = await dispatch(
    new Request("https://api.test/v1/keys", {
      method: "POST",
      headers: {
        authorization: `Bearer ${deviceToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ kind: "agent", name: "claude" }),
    }),
    ctx,
  );
  assert.equal(minted.status, 201);
  assert.equal(mail.sent.length, 1);
});

test("sign-out-everywhere and device logout each send one mail", async () => {
  const store = createMemoryStore({ now: () => Date.parse(HAPPENED_AT) });
  const mail = fakeEmail();
  const { deviceToken, ctx } = await signIn(store, "office laptop", mail);
  mail.sent.length = 0;

  const everywhere = await dispatch(
    new Request("https://api.test/v1/keys", {
      method: "DELETE",
      headers: { authorization: `Bearer ${deviceToken}` },
    }),
    ctx,
  );
  assert.equal(everywhere.status, 204);
  assert.equal(mail.sent.length, 1);
  assert.match(
    String(/** @type {{text: string}} */ (mail.sent[0]).text),
    /Every device was signed out/,
  );
  assert.match(String(/** @type {{text: string}} */ (mail.sent[0]).text), /this device/);

  const store2 = createMemoryStore({ now: () => Date.parse(HAPPENED_AT) });
  const working = fakeEmail();
  const signed = await signIn(store2, "office laptop", working);
  const mail2 = fakeEmail(new Error("vendor down"));
  signed.ctx.env.EMAIL = mail2;
  const loggedOut = await dispatch(
    new Request("https://api.test/v1/device/token", {
      method: "DELETE",
      headers: { authorization: `Bearer ${signed.deviceToken}` },
    }),
    signed.ctx,
  );
  assert.equal(loggedOut.status, 204, "a mail failure does not fail the logout");
  assert.equal(mail2.sent.length, 1);
  assert.match(
    String(/** @type {{text: string}} */ (mail2.sent[0]).text),
    /A device was signed out/,
  );
  assert.match(String(/** @type {{text: string}} */ (mail2.sent[0]).text), /this device/);
});

test("minting a team key sends one mail", async () => {
  const mail = fakeEmail();
  const minted = await mintTeamKeyRoute(
    new Request("https://api.test/v1/teams/team_1/key", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "ravi-laptop" }),
    }),
    {
      env: { EMAIL: mail, MAIL_FROM },
      account: { id: "acct_1", name: "You", email: "you@example.com" },
      params: { teamId: "team_1" },
      store: {
        teams: {
          acceptInvite: async () => ({ role: "read_write" }),
          teamForAccount: async () => ({ id: "team_1", ownerAccountId: "acct_1" }),
        },
        mintTeamKey: async () => ({ keyId: "k1", secret: "s" }),
      },
    },
  );
  assert.equal(minted.status, 201);
  assert.equal(mail.sent.length, 1);
  assert.match(String(/** @type {{text: string}} */ (mail.sent[0]).text), /team key/);
  assert.match(String(/** @type {{text: string}} */ (mail.sent[0]).text), /ravi-laptop/);
});
