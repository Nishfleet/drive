import { first } from "./db.js";
import { errorResponse, json, readJsonObject } from "./http.js";
import { failureMessage } from "./messages.js";
import { unauthorizedResponse } from "./status.js";

export const MILESTONES_ENDPOINT = "/api/milestones";

const GB = 1_000_000_000;

const MILESTONES = Object.freeze([
  {
    id: "first-file",
    text: "Your first file is in your drive.",
    reached:
      "SELECT EXISTS(SELECT 1 FROM file_versions WHERE account_id = ?1) OR EXISTS(SELECT 1 FROM file_index WHERE account_id = ?1) AS hit",
  },
  {
    id: "first-agent",
    text: "Your first agent is connected.",
    reached: "SELECT EXISTS(SELECT 1 FROM devices WHERE account_id = ?1 AND kind = 'agent') AS hit",
  },
  {
    id: "first-gb",
    text: "Your drive has passed 1 GB.",
    reached: `SELECT COALESCE(MAX(stored_bytes), 0) >= ${GB} AS hit FROM usage_minutes WHERE account_id = ?1`,
  },
  {
    id: "one-year",
    text: "One year on Storagebun. Thank you.",
    reached:
      "SELECT created_at <= datetime(?2 / 1000, 'unixepoch', '-365 days') AS hit FROM accounts WHERE id = ?1",
  },
]);

/**
 * @param {D1Database} db
 * @param {string} accountId
 * @param {number} now
 */
async function unseen(db, accountId, now) {
  const row = /** @type {{milestones_seen: string|null}|null} */ (
    await first(db, "SELECT milestones_seen FROM accounts WHERE id = ?1", accountId)
  );
  const seen = new Set((row?.milestones_seen ?? "").split(",").filter(Boolean));
  const fresh = [];
  for (const milestone of MILESTONES) {
    if (seen.has(milestone.id)) continue;
    const answer = /** @type {{hit: number}|null} */ (
      await db.prepare(milestone.reached).bind(accountId, now).first()
    );
    if (Number(answer?.hit ?? 0) === 1) fresh.push({ id: milestone.id, text: milestone.text });
  }
  return { seen, fresh };
}

/**
 * @param {Request} request
 * @param {{id: string}|null} account
 * @param {D1Database|undefined} db
 * @param {{now?: number}} [options]
 */
export async function handleMilestonesRequest(request, account, db, options = {}) {
  if (!account) return unauthorizedResponse();
  if (!db) return json({ error: failureMessage("drive-not-configured") }, 503);
  const now = options.now ?? Date.now();
  if (request.method === "GET") {
    const { fresh } = await unseen(db, account.id, now);
    return json({ milestones: fresh });
  }
  if (request.method === "POST") {
    const read = await readJsonObject(request);
    if ("error" in read) return errorResponse(400, read.error);
    const { seen, fresh } = await unseen(db, account.id, now);
    const told = Array.isArray(read.body.ids) ? read.body.ids : [];
    const next = new Set(seen);
    for (const milestone of fresh) {
      if (told.includes(milestone.id)) next.add(milestone.id);
    }
    await db
      .prepare("UPDATE accounts SET milestones_seen = ?1 WHERE id = ?2")
      .bind([...next].join(","), account.id)
      .run();
    return json({ ok: true });
  }
  return errorResponse(405, "Method not allowed.", { allow: "GET, POST" });
}
