// Founding-member flag and offer switch (drive issue #386).
//
// The cap and the remaining-spots count stay on the server. Assertions below
// fail if a public answer, page, email or message carries them.

import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { test } from "node:test";
import { handleUsageRequest } from "../src/billing.js";
import { EMAIL_KINDS, renderEmail } from "../src/emails.js";
import {
  accountFounding,
  confirmFounding,
  FOUNDING_OFFER_VAR,
  FOUNDING_PAYING_CAP,
  foundingOfferIsOpen,
  markAccountPaying,
  releaseFoundingReservation,
  reserveFoundingSlot,
} from "../src/founding.js";
import { FAILURE_MESSAGES } from "../src/messages.js";
import { PRICE } from "../src/pricing.js";
import { makeMeteredDB } from "./d1-sqlite.mjs";

const NOW = Date.parse("2026-10-04T12:00:00.000Z");

const LEAK =
  /remaining[- ]spots|spots left|first 1,?000 paying|1,?000 (paying )?accounts|founding (cap|limit|spots)/i;

/**
 * @param {import("./d1-sqlite.mjs").MeteredD1} db
 * @param {string} id
 * @param {0|1|null} [founding]
 */
async function insertAccount(db, id, founding = null) {
  await db
    .prepare("INSERT INTO accounts (id, email, created_at, founding) VALUES (?1, ?2, 0, ?3)")
    .bind(id, `${id}@example.com`, founding)
    .run();
}

/**
 * @param {import("./d1-sqlite.mjs").TestSqlite} sqlite
 * @param {number} count
 * @param {0|1} founding
 */
function seedPaying(sqlite, count, founding) {
  sqlite.exec("BEGIN");
  const insert = sqlite.prepare(
    "INSERT INTO accounts (id, email, created_at, founding) VALUES (?, ?, 0, ?)",
  );
  for (let i = 0; i < count; i++) {
    insert.run(`paid-${i}`, `paid-${i}@example.com`, founding);
  }
  sqlite.exec("COMMIT");
}

test("the offer switch reads the Worker var, and a missing var stays open", () => {
  assert.equal(FOUNDING_OFFER_VAR, "FOUNDING_OFFER_OPEN");
  assert.equal(FOUNDING_PAYING_CAP, 1000);
  assert.equal(foundingOfferIsOpen(undefined), true);
  assert.equal(foundingOfferIsOpen(null), true);
  assert.equal(foundingOfferIsOpen(""), true);
  assert.equal(foundingOfferIsOpen("1"), true);
  assert.equal(foundingOfferIsOpen("true"), true);
  assert.equal(foundingOfferIsOpen("on"), true);
  assert.equal(foundingOfferIsOpen("0"), false);
  assert.equal(foundingOfferIsOpen("false"), false);
  assert.equal(foundingOfferIsOpen("off"), false);
  assert.throws(() => foundingOfferIsOpen("maybe"), /must be 1, 0, true, false, on or off/);
  assert.throws(() => foundingOfferIsOpen(1), /must be a string/);
});

test("account 1000 gets the reserved slot and account 1001 does not", async () => {
  const { db, sqlite } = makeMeteredDB();
  seedPaying(sqlite, 999, 1);
  await insertAccount(db, "acct-1000");
  await insertAccount(db, "acct-1001");

  const thousand = await reserveFoundingSlot(db, "acct-1000", { offerOpen: true, now: NOW });
  assert.deepEqual(thousand, { founding: false, reserved: true });
  assert.equal(
    sqlite.prepare("SELECT founding_reserved FROM accounts WHERE id = ?").get("acct-1000")
      .founding_reserved,
    1,
  );

  const thousandOne = await reserveFoundingSlot(db, "acct-1001", { offerOpen: true, now: NOW });
  assert.deepEqual(thousandOne, { founding: false, reserved: false });
  assert.equal(
    sqlite.prepare("SELECT founding_reserved FROM accounts WHERE id = ?").get("acct-1001")
      .founding_reserved,
    0,
  );

  assert.deepEqual(await confirmFounding(db, "acct-1000", { now: NOW }), { founding: true });
  assert.deepEqual(await confirmFounding(db, "acct-1001", { now: NOW }), { founding: false });
});

test("switch-off stops new reservations and keeps old ones", async () => {
  const { db, sqlite } = makeMeteredDB();
  await insertAccount(db, "founder");
  assert.deepEqual(await reserveFoundingSlot(db, "founder", { offerOpen: true, now: NOW }), {
    founding: false,
    reserved: true,
  });

  await insertAccount(db, "late");
  assert.deepEqual(await reserveFoundingSlot(db, "late", { offerOpen: false, now: NOW }), {
    founding: false,
    reserved: false,
  });
  assert.equal(
    sqlite.prepare("SELECT founding_reserved FROM accounts WHERE id = ?").get("founder")
      .founding_reserved,
    1,
  );
  assert.equal(
    sqlite.prepare("SELECT founding_reserved FROM accounts WHERE id = ?").get("late")
      .founding_reserved,
    0,
  );

  assert.deepEqual(await reserveFoundingSlot(db, "founder", { offerOpen: false, now: NOW }), {
    founding: false,
    reserved: true,
  });
  assert.deepEqual(await confirmFounding(db, "founder", { now: NOW }), { founding: true });
});

test("a decided non-founder stays 0 after the offer opens again", async () => {
  const { db, sqlite } = makeMeteredDB();
  await insertAccount(db, "closed-then-open");
  await reserveFoundingSlot(db, "closed-then-open", { offerOpen: false, now: NOW });
  await markAccountPaying(db, "closed-then-open", { offerOpen: true, now: NOW });
  assert.deepEqual(await markAccountPaying(db, "closed-then-open", { offerOpen: true, now: NOW }), {
    founding: false,
  });
  assert.equal(
    sqlite.prepare("SELECT founding FROM accounts WHERE id = ?").get("closed-then-open").founding,
    0,
  );
});

test("markAccountPaying refuses a missing account and a non-boolean switch", async () => {
  const { db } = makeMeteredDB();
  await assert.rejects(
    markAccountPaying(db, "missing", { offerOpen: true, now: NOW }),
    /needs an accounts row/,
  );
  await insertAccount(db, "acct");
  const badOffer = /** @type {{offerOpen: boolean}} */ (
    /** @type {unknown} */ ({ offerOpen: "1" })
  );
  await assert.rejects(markAccountPaying(db, "acct", badOffer), /offerOpen must be a boolean/);
  await assert.rejects(markAccountPaying(db, "", { offerOpen: true }), /account id/);
});

test("accountFounding reads the stored flag and treats unset as not founding", async () => {
  const { db } = makeMeteredDB();
  await insertAccount(db, "unset");
  assert.deepEqual(await accountFounding(db, "unset"), { founding: false });
  await reserveFoundingSlot(db, "unset", { offerOpen: true, now: NOW });
  assert.deepEqual(await accountFounding(db, "unset"), { founding: false });
  await markAccountPaying(db, "unset", { offerOpen: true, now: NOW });
  assert.deepEqual(await accountFounding(db, "unset"), { founding: true });
  await assert.rejects(accountFounding(db, "nope"), /needs an accounts row/);
});

test("a public founding answer never carries the cap or a remaining-spots count", async () => {
  const { db } = makeMeteredDB();
  await insertAccount(db, "acct");
  await reserveFoundingSlot(db, "acct", { offerOpen: true, now: NOW });
  const body = JSON.stringify(await markAccountPaying(db, "acct", { offerOpen: true, now: NOW }));
  assert.equal(body.includes("1000"), false, body);
  assert.equal(body.includes("1,000"), false, body);
  assert.doesNotMatch(body, /remaining/i);
  assert.deepEqual(JSON.parse(body), { founding: true });
  assert.equal(Object.keys(JSON.parse(body)).join(","), "founding");
});

test("pages, emails, messages and usage JSON do not leak the founding cap", async () => {
  /** @param {string} kind */
  function dataFor(kind) {
    if (kind === "welcome") return {};
    if (kind === "cap-warning" || kind === "read-only") return { capUsd: 12 };
    if (kind === "payment-failed") return { amountUsd: 23.5 };
    if (kind === "monthly-receipt") {
      return { billUsd: 12, meteredUsd: 16, ceilingUsd: 12, capped: true };
    }
    if (kind === "account-closed" || kind === "account-close-reminder") {
      return { graceDays: 30, reminderDays: 25, purgeOn: "3 Nov" };
    }
    throw new Error(`no test data for ${kind}`);
  }
  const pages = readdirSync(new URL("../public/", import.meta.url))
    .filter((name) => name.endsWith(".html"))
    .map((name) => readFileSync(new URL(`../public/${name}`, import.meta.url), "utf8"));
  const copy = [
    ...pages,
    JSON.stringify(FAILURE_MESSAGES),
    JSON.stringify(PRICE),
    ...EMAIL_KINDS.flatMap((kind) => {
      const rendered = renderEmail(kind, dataFor(kind));
      return [rendered.subject, rendered.text, rendered.html];
    }),
  ];
  for (const text of copy) {
    assert.doesNotMatch(text, LEAK, text.slice(0, 180));
  }

  const usage = handleUsageRequest(new Request("https://drive.example/api/usage"), {
    id: "acct",
    name: "acct",
  });
  const usageBody = await usage.text();
  assert.doesNotMatch(usageBody, LEAK);
});

test("closing before paying releases the reserved slot", async () => {
  const { db, sqlite } = makeMeteredDB();
  await insertAccount(db, "acct");
  await reserveFoundingSlot(db, "acct", { offerOpen: true, now: NOW });
  await releaseFoundingReservation(db, "acct");
  assert.equal(
    sqlite.prepare("SELECT founding_reserved FROM accounts WHERE id = ?").get("acct")
      .founding_reserved,
    null,
  );
  assert.deepEqual(await confirmFounding(db, "acct", { now: NOW }), { founding: false });
});

test("both Worker configs declare FOUNDING_OFFER_OPEN as a text var defaulting to open", async () => {
  const site = readFileSync(new URL("../cloudflare.config.ts", import.meta.url), "utf8");
  const api = readFileSync(new URL("../workers/api/cloudflare.config.ts", import.meta.url), "utf8");
  const pin = `${FOUNDING_OFFER_VAR}: bindings.text("1")`;
  assert.ok(site.includes(pin), "site Worker declares the offer switch");
  assert.ok(api.includes(pin), "api Worker declares the offer switch");
});
