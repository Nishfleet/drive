// The spending cap enforced by itself (drive#496): the hourly walk saves each
// metered account's state and mails the 80% and read-only notices once per
// state change, and the routes a read-only drive must refuse read that state
// through the Worker's own dispatch.
//
// Every month here is downloads alone: the hour row stores 1 GB on average and
// no GB-minutes, so the only line on the bill is the downloads past the free
// 3x allowance. That is the case the old cap read missed, because it returned
// `downloadBytes: 0`.

import assert from "node:assert/strict";
import { test } from "node:test";
import { runCapEnforcement } from "../src/cap.js";
import worker from "../src/index.js";
import { HOUR_MS, hourStart, METER_CRON, monthStart } from "../src/meter.js";
import { createD1LinkStore, newRequestRecord } from "../src/share.js";
import { createD1DeviceStore } from "../workers/api/src/devices.js";
import { createTestAuth, DRIVE_MIGRATIONS, signIn, TEST_SECRET } from "./harness.mjs";

/** @type {(request: Request, env?: unknown) => Promise<Response>} */
const workerFetch = /** @type {any} */ (worker.fetch);

const GB = 1_000_000_000;
const TOKEN = "CCCCCCCCCCCCCCCCCCCCCC";

// 503 GB downloaded over a 1 GB average: 500 GB past the free 3 GB, at
// $0.01 a GB, is $5.00 counted with no storage line at all.
const DOWNLOADED_BYTES = 503 * GB;

function passLimiter() {
  return { limit: () => Promise.resolve({ success: true }) };
}

/**
 * A signed-in account with a cap and a month of downloads in usage_minutes.
 * @param {number} capCents
 */
async function seeded(capCents) {
  const made = createTestAuth({ migrations: DRIVE_MIGRATIONS });
  const { cookie, account } = await signIn(made, "capped@example.com");
  await made.db
    .prepare(
      "INSERT INTO accounts (id, email, created_at, cap_cents, state) VALUES (?1, ?2, 0, ?3, 'active')",
    )
    .bind(account.id, account.email, capCents)
    .run();
  await made.db
    .prepare(
      `INSERT INTO usage_minutes (account_id, hour, gb_minutes_live, download_bytes, stored_bytes, rolled_up_at)
       VALUES (?1, ?2, 0, ?3, ?4, ?2)`,
    )
    .bind(account.id, hourStart(Date.now()), DOWNLOADED_BYTES, GB)
    .run();
  /** @type {Array<{to: string, subject: string}>} */
  const mail = [];
  const email = {
    /** @param {{to: string, subject: string}} message */
    send: async (message) => {
      mail.push({ to: message.to, subject: message.subject });
      return { messageId: `m-${mail.length}` };
    },
  };
  const env = {
    ASSETS: { fetch: () => new Response("asset", { status: 200 }) },
    DRIVE_DB: made.db,
    BETTER_AUTH_SECRET: TEST_SECRET,
    BETTER_AUTH_URL: "https://drive.test",
    REQUEST_UPLOAD_RATE_LIMITER: passLimiter(),
    REQUEST_UPLOAD_LINK_RATE_LIMITER: passLimiter(),
  };
  const walk = () =>
    runCapEnforcement({
      store: createD1DeviceStore(made.db),
      email,
      mailFrom: "drive@drive.test",
    });
  const state = async () =>
    /** @type {{state: string}} */ (
      await made.db.prepare("SELECT state FROM accounts WHERE id = ?1").bind(account.id).first()
    ).state;
  return { made, cookie, account, env, mail, email, walk, state };
}

/**
 * @param {Awaited<ReturnType<typeof seeded>>} drive
 * @param {string} path
 */
function upload(drive, path) {
  /** @type {Record<string, string>} */
  const headers = path.startsWith("/api/files")
    ? { cookie: drive.cookie, origin: "https://drive.test", "sec-fetch-site": "same-origin" }
    : {};
  return workerFetch(
    new Request(`https://drive.test${path}`, { method: "POST", headers, body: "x" }),
    drive.env,
  );
}

test("a month of downloads over the cap: the walk saves read_only and mails once", async () => {
  const { account, mail, walk, state } = await seeded(400);
  const first = await walk();
  assert.deepEqual(first.failures, []);
  assert.equal(first.readOnly, 1);
  assert.equal(await state(), "read_only", "the walk did not save the state");
  assert.equal(mail.length, 1, "the read-only notice did not go out");
  assert.equal(mail[0].to, account.email);
  assert.equal(first.results[0].countedUsd, 5, "downloads alone count $5.00");

  // The next hourly run finds the same state, so it mails nothing.
  const second = await walk();
  assert.equal(second.mailed, 0);
  assert.equal(mail.length, 1, "the notice went out twice for one state change");
});

test("at 80% of the cap the warning goes out once, and re-arms after it falls back", async () => {
  const { made, account, mail, walk, state } = await seeded(600);
  const first = await walk();
  assert.equal(await state(), "active", "$5.00 of a $6.00 cap is still writable");
  assert.equal(first.warned, 1);
  assert.equal(mail.length, 1);
  await walk();
  assert.equal(mail.length, 1, "the warning went out twice for one crossing");

  // A cap raise to $10 puts the month at 50%: no mail, and the stamp clears,
  // so a later crossing is a new state change that is mailed again.
  await createD1DeviceStore(made.db).setCapCents(account, 1000);
  assert.equal((await walk()).mailed, 0);
  await createD1DeviceStore(made.db).setCapCents(account, 600);
  assert.equal((await walk()).warned, 1);
  assert.equal(mail.length, 2);
});

test("a closed account is never re-opened or mailed by the walk", async () => {
  const { made, account, mail, walk, state } = await seeded(400);
  await made.db
    .prepare("UPDATE accounts SET state = 'closed', closed_at = 1 WHERE id = ?1")
    .bind(account.id)
    .run();
  const report = await walk();
  assert.equal(report.skipped, 1);
  assert.equal(await state(), "closed");
  assert.equal(mail.length, 0);
  // The cap route's own write is guarded the same way (drive#537).
  await createD1DeviceStore(made.db).setAccountState(account.id, "active");
  assert.equal(await state(), "closed");
});

test("over the cap, the routes refuse writes and /api/usage shows the real month", async () => {
  const drive = await seeded(400);
  const { made, cookie, account, env, walk } = drive;

  // /api/usage reads the metered month, downloads included, not an empty one.
  const usage = await (
    await workerFetch(new Request("https://drive.test/api/usage", { headers: { cookie } }), env)
  ).json();
  assert.equal(usage.downloads.usedBytes, DOWNLOADED_BYTES, "the usage read dropped the downloads");
  assert.equal(usage.cap.countedUsd, 5);
  assert.equal(usage.cap.state, "read_only");

  // The owner's public upload-request link stops at the owner's cap.
  await createD1LinkStore(made.db).requests.create(
    newRequestRecord({ accountId: account.id, folder: "/", now: Date.now(), token: TOKEN }),
  );
  const requestUpload = await upload(drive, `/api/request/upload?k=${TOKEN}&name=a.txt`);
  assert.equal(requestUpload.status, 403, "the upload-request link ignored the cap");

  // The walk saves read_only, and the web upload lane reads it.
  await walk();
  const web = await upload(drive, "/api/files/upload?name=a.txt");
  assert.equal(web.status, 403, "a read-only drive took a web upload");
});

test("under the cap, the same routes still take the upload", async () => {
  const drive = await seeded(10_000);
  await drive.walk();
  await createD1LinkStore(drive.made.db).requests.create(
    newRequestRecord({ accountId: drive.account.id, folder: "/", now: Date.now(), token: TOKEN }),
  );
  const requestUpload = await upload(drive, `/api/request/upload?k=${TOKEN}&name=a.txt`);
  assert.notEqual(requestUpload.status, 403, await requestUpload.clone().text());
  const web = await upload(drive, "/api/files/upload?name=a.txt");
  assert.notEqual(web.status, 403, await web.clone().text());
});

test("the hourly meter trigger runs the cap walk after its rollup", async () => {
  // The real scheduled() path: the rollup re-writes this hour's row from
  // file_versions (one 1 GB file live all month), keeps its download bytes,
  // and the walk that follows it saves read_only and mails once.
  const { made, account, env, mail, email, state } = await seeded(400);
  await made.db
    .prepare(
      `INSERT INTO file_versions (account_id, b2_file_id, path, size_bytes, created_at)
       VALUES (?1, 'f-1', ?2, ?3, ?4)`,
    )
    .bind(account.id, `/u/${account.id}/big.bin`, GB, monthStart(Date.now()))
    .run();
  const trigger = /** @type {{scheduled(event: unknown, env: unknown): Promise<unknown>}} */ (
    /** @type {unknown} */ (worker)
  );
  const cronEnv = { ...env, METER_DB: made.db, EMAIL: email, MAIL_FROM: "drive@drive.test" };
  await trigger.scheduled({ cron: METER_CRON, scheduledTime: Date.now() + HOUR_MS }, cronEnv);
  assert.equal(await state(), "read_only", "the trigger did not enforce the cap");
  assert.equal(mail.length, 1);
  await trigger.scheduled({ cron: METER_CRON, scheduledTime: Date.now() + HOUR_MS }, cronEnv);
  assert.equal(mail.length, 1, "the second hourly run mailed the same state again");
});

test("a new month opens a drive the last month left read-only", async () => {
  // Last month's read-only drive has no usage row yet this month. The walk
  // still finds it by its saved state, makes it writable, and re-arms the
  // notice so a cap reached again this month is mailed again.
  const { made, account, mail, walk, state } = await seeded(400);
  await walk();
  assert.equal(await state(), "read_only");
  await made.db.prepare("DELETE FROM usage_minutes WHERE account_id = ?1").bind(account.id).run();
  const report = await walk();
  assert.deepEqual(report.failures, []);
  assert.equal(
    await state(),
    "active",
    "the drive stayed read-only into a month it spent nothing in",
  );
  const row = /** @type {{read_only_sent_at: unknown}} */ (
    await made.db
      .prepare("SELECT read_only_sent_at FROM accounts WHERE id = ?1")
      .bind(account.id)
      .first()
  );
  assert.equal(row.read_only_sent_at, null);
  assert.equal(mail.length, 1);
});

test("a closed account's upload-request link takes no upload", async () => {
  const drive = await seeded(10_000);
  await drive.made.db
    .prepare("UPDATE accounts SET state = 'closed', closed_at = 1 WHERE id = ?1")
    .bind(drive.account.id)
    .run();
  await createD1LinkStore(drive.made.db).requests.create(
    newRequestRecord({ accountId: drive.account.id, folder: "/", now: Date.now(), token: TOKEN }),
  );
  const requestUpload = await upload(drive, `/api/request/upload?k=${TOKEN}&name=a.txt`);
  assert.equal(requestUpload.status, 403);
});
