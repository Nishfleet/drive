// Thin helpers over D1 so route code reads as SQL plus intent. Every value is
// bound, never interpolated.

/**
 * @param {D1Database} db
 * @param {string} sql
 * @param {unknown[]} params
 */
export function first(db, sql, ...params) {
  return db.prepare(sql).bind(...params).first();
}

/**
 * @param {D1Database} db
 * @param {string} sql
 * @param {unknown[]} params
 * @returns {Promise<any[]>}
 */
export async function all(db, sql, ...params) {
  const result = await db.prepare(sql).bind(...params).all();
  return result.results;
}

/**
 * @param {D1Database} db
 * @param {string} sql
 * @param {unknown[]} params
 */
export function run(db, sql, ...params) {
  return db.prepare(sql).bind(...params).run();
}

/** Seconds since the epoch: the one clock format in the api tables. */
export function nowSeconds(now = Date.now()) {
  return Math.floor(now / 1000);
}

const HEX = "0123456789abcdef";

function toHex(bytes) {
  let out = "";
  for (const byte of bytes) {
    out += HEX[byte >> 4] + HEX[byte & 15];
  }
  return out;
}

/**
 * A random id with a readable prefix, e.g. acct_3f9c... (128 bits).
 * @param {string} prefix
 */
export function newId(prefix) {
  return `${prefix}_${toHex(crypto.getRandomValues(new Uint8Array(16)))}`;
}

/**
 * Hex SHA-256. Bearer tokens and one-time codes are stored only as this.
 * @param {string} text
 */
export async function sha256Hex(text) {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(text),
  );
  return toHex(new Uint8Array(digest));
}
