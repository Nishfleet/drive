// Shared helpers for the device-signin-d1 tests (drive issue #617: split out of
// device-signin-d1.test.js, code unchanged).

import "urlpattern-polyfill";
import { AUTH_COOKIE_PREFIX } from "../../../core/auth.js";

// The session cookie Better Auth mints, named by core/auth.js
// `AUTH_COOKIE_PREFIX` (the same name test/auth.test.mjs asserts against a real
// instance): `__Secure-` because the site is HTTPS only, then the prefix, then
// Better Auth's own session name.
export const SESSION_COOKIE = `__Secure-${AUTH_COOKIE_PREFIX}.session_token`;

// The sign-in store the api Worker resolves a browser approval through:
// core/auth.js `authFor` builds a Better Auth instance and core/status.js
// `signedInAccount` asks it for the session the cookie names, so a stand-in
// here speaks `api.getSession`. One token is signed in; every other value the
// browser could have invented has no session.
/** @param {string} token */
export function accountsFor(token) {
  return {
    api: {
      /** @param {{headers: Headers}} options */
      async getSession({ headers }) {
        const cookie = headers.get("cookie") ?? "";
        const found = cookie
          .split(";")
          .map((part) => part.trim())
          .find((part) => part.startsWith(`${SESSION_COOKIE}=`));
        const value = found?.slice(SESSION_COOKIE.length + 1);
        return value === token ? { user: ACCOUNT } : null;
      },
    },
  };
}

// A minimal D1 stand-in for the device sign-in store: it implements the exact
// statements device-signin.js prepares, over Maps, so two store instances share
// one database the way two Worker isolates share a real D1. That sharing is the
// point of the test — the code lives in the database, not in module state.
//
// `batch` is a transaction here, as it is in D1: the statements run in order
// and a throw rolls every one of them back, so the store's "consume the code
// and write the token together" is really tested rather than asserted.
// `options.onRead` fires on every `first()`, which is how a test crosses the
// TTL between a read and the write that follows it; `options.failOn` names a
// statement prefix that throws, which is how a half-written pair is tested.
/**
 * @typedef {{onRead?: () => void, failOn?: string}} FakeD1Options
 * @typedef {{codes: Map<string, any>, byUserCode: Map<string, any>, tokens: Map<string, any>}} FakeD1Snapshot
 * @typedef {D1Database & {codes: Map<string, any>, byUserCode: Map<string, any>, tokens: Map<string, any>}} FakeD1
 */
/** @param {FakeD1Options} [options] @returns {FakeD1} */
export function makeFakeD1(options = {}) {
  /** @type {Map<string, any>} */ const codes = new Map();
  /** @type {Map<string, any>} */ const byUserCode = new Map();
  /** @type {Map<string, any>} */ const tokens = new Map();

  /** @returns {FakeD1Snapshot} */
  const snapshot = () => ({
    codes: new Map([...codes].map(([k, v]) => [k, { ...v }])),
    byUserCode: new Map(byUserCode),
    tokens: new Map(tokens),
  });
  /** @param {FakeD1Snapshot} snap */
  const restore = (snap) => {
    codes.clear();
    byUserCode.clear();
    tokens.clear();
    for (const [k, v] of snap.codes) {
      codes.set(k, v);
    }
    for (const [k, v] of snap.byUserCode) {
      byUserCode.set(k, v);
    }
    for (const [k, v] of snap.tokens) {
      tokens.set(k, v);
    }
  };

  /** One statement, the way D1 runs it: mutate, or throw and change nothing.
   * @param {string} s
   * @param {unknown[]} args
   */
  function runStatement(s, args) {
    /** @type {any[]} */
    const params = args;
    if (options.failOn !== undefined && s.startsWith(options.failOn)) {
      // One failure, then the database behaves again: the test proves the
      // retry after the rollback succeeds.
      delete options.failOn;
      throw new Error(
        `fake D1: ${s.split(" ")[0]} ${s.split(" ")[1]} ${s.split(" ")[2]} was made to fail`,
      );
    }
    if (s.startsWith("DELETE FROM device_codes")) {
      let changes = 0;
      for (const [hash, row] of codes) {
        if (row.expires_at <= params[0]) {
          codes.delete(hash);
          byUserCode.delete(row.user_code);
          changes += 1;
        }
      }
      return { success: true, meta: { changes } };
    }
    if (s.startsWith("INSERT INTO device_codes")) {
      const [hash, userCode, name, createdAt, expiresAt] = params;
      const row = {
        device_code_hash: hash,
        user_code: userCode,
        name,
        status: "pending",
        account_id: "",
        account_name: "",
        account_email: "",
        created_at: createdAt,
        expires_at: expiresAt,
        consumed_by: "",
      };
      codes.set(hash, row);
      byUserCode.set(userCode, row);
      return { success: true, meta: { changes: 1 } };
    }
    if (s.startsWith("UPDATE device_codes SET status = 'approved'")) {
      const [accountId, accountName, accountEmail, userCode, nowSecondsAt] = params;
      const row = byUserCode.get(userCode);
      if (row?.status !== "pending" || row.expires_at <= nowSecondsAt) {
        return { success: true, meta: { changes: 0 } };
      }
      row.status = "approved";
      row.account_id = accountId;
      row.account_name = accountName;
      row.account_email = accountEmail;
      return { success: true, meta: { changes: 1 } };
    }
    if (s.startsWith("UPDATE device_codes SET status = 'used'")) {
      const [nonce, hash, nowSecondsAt] = params;
      const row = codes.get(hash);
      if (row?.status !== "approved" || row.consumed_by !== "" || row.expires_at <= nowSecondsAt) {
        return { success: true, meta: { changes: 0 } };
      }
      row.status = "used";
      row.consumed_by = nonce;
      return { success: true, meta: { changes: 1 } };
    }
    if (s.startsWith("INSERT INTO device_tokens")) {
      const [hash, accountId, accountName, accountEmail, createdAt, expiresAt, codeHash, nonce] =
        params;
      // `INSERT ... SELECT ... WHERE EXISTS (… consumed_by = ?8)`: the row the
      // insert reads is the row the update above stamped, so a poll that lost
      // the race matches nothing and writes no token at all.
      if (codes.get(codeHash)?.consumed_by !== nonce) {
        return { success: true, meta: { changes: 0 } };
      }
      tokens.set(hash, {
        token_hash: hash,
        account_id: accountId,
        account_name: accountName,
        account_email: accountEmail,
        created_at: createdAt,
        expires_at: expiresAt,
        revoked_at: null,
        // The LEFT JOIN `accountForDeviceToken` reads for the close state
        // (drive#497): this fake has no accounts table, so the joined column is
        // null, which is "not closed".
        account_state: null,
      });
      return { success: true, meta: { changes: 1 } };
    }
    if (s.startsWith("UPDATE device_tokens SET revoked_at")) {
      const [revokedAt, hash] = params;
      const row = tokens.get(hash);
      if (row === undefined || row.revoked_at !== null) {
        return { success: true, meta: { changes: 0 } };
      }
      row.revoked_at = revokedAt;
      return { success: true, meta: { changes: 1 } };
    }
    if (s.startsWith("DELETE FROM device_tokens")) {
      const [at] = params;
      let changes = 0;
      for (const [hash, row] of tokens) {
        if (row.expires_at <= at || row.revoked_at !== null) {
          tokens.delete(hash);
          changes += 1;
        }
      }
      return { success: true, meta: { changes } };
    }
    throw new Error(`fake D1: unexpected run() SQL: ${s}`);
  }

  /** @param {string} sql */
  function prepare(sql) {
    const s = sql.replace(/\s+/g, " ").trim();
    return {
      /** @param {...unknown} params */
      bind(...params) {
        return {
          sql: s,
          params,
          async first() {
            options.onRead?.();
            if (s.includes("FROM device_codes WHERE user_code")) {
              return byUserCode.get(/** @type {string} */ (params[0])) ?? null;
            }
            if (s.includes("FROM device_codes WHERE device_code_hash")) {
              return codes.get(/** @type {string} */ (params[0])) ?? null;
            }
            if (s.includes("FROM device_tokens") && s.includes("token_hash")) {
              const row = tokens.get(/** @type {string} */ (params[0]));
              if (row === undefined) {
                return null;
              }
              // The lookup's own predicates, so the store cannot pass them by
              // reading a dead row and checking it somewhere else.
              if (s.includes("revoked_at IS NULL") && row.revoked_at !== null) {
                return null;
              }
              if (
                s.includes("expires_at >") &&
                row.expires_at <= /** @type {number} */ (params[1])
              ) {
                return null;
              }
              return row;
            }
            throw new Error(`fake D1: unexpected first() SQL: ${s}`);
          },
          async run() {
            return runStatement(s, params);
          },
        };
      },
    };
  }

  return /** @type {FakeD1} */ (
    /** @type {unknown} */ ({
      prepare,
      /**
       * @param {Array<{sql: string, params: unknown[]}>} statements
       */
      async batch(statements) {
        const snap = snapshot();
        const results = [];
        try {
          for (const statement of statements) {
            results.push(runStatement(statement.sql, statement.params));
          }
        } catch (error) {
          restore(snap);
          throw error;
        }
        return results;
      },
      codes,
      byUserCode,
      tokens,
    })
  );
}

export const ACCOUNT = { id: "acct_1", name: "Nish", email: "nish@example.com" };
