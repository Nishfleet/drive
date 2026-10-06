// Better Auth over D1 without Kysely (drive#758).
//
// `better-auth` (the full entry) talks to a raw D1 binding through Kysely, and
// that path statically imports every dialect Kysely ships — Postgres, MySQL,
// MSSQL, Bun SQLite, Node SQLite — plus the migration planner. `cf build`
// emits those unused chunks next to the isolate script, and the site-bundle
// ratchet counts them. On main that graph was 797,930 bytes; this adapter
// keeps the factory chunk (~264 KB) and drops the rest, so the measured
// site-bundle fell from 3,038,606 to 2,502,977 bytes.
//
// The stock shrink is `better-auth/minimal` plus an adapter from
// `createAdapterFactory` (`better-auth/adapters`): the factory is the
// extension point, and D1 already speaks SQL through core/db.js. The Worker
// then ships one dialect — this file — instead of Kysely's set.
// Returned rows stay keyed by column name; `createAdapterFactory`'s
// `transformOutput` maps them back to field names (same as the Kysely
// adapter). The SQLite flags below copy `@better-auth/kysely-adapter`'s
// sqlite branch (`supportsBooleans` / `supportsDates` false), so live D1
// rows keep the 0/1 and ISO-string shape the shipped migrations already
// store.

import { createAdapterFactory } from "better-auth/adapters";
import { all, first, run } from "./db.js";

/**
 * Quote a SQL identifier. Values stay bound; only names go through here.
 * Names come from Better Auth's schema (`getFieldName` / table names), never
 * from a caller-supplied string.
 * @param {string} name
 */
function ident(name) {
  if (typeof name !== "string" || name === "") {
    throw new Error("auth D1 adapter: SQL identifier is empty");
  }
  return `"${name.replaceAll('"', '""')}"`;
}

/**
 * @param {string} column
 * @param {{operator?: string, value?: unknown, mode?: string}} clause
 * @param {unknown[]} params
 */
function predicateSql(column, clause, params) {
  const operator = clause.operator ?? "eq";
  const value = clause.value;
  const insensitive = clause.mode === "insensitive";
  const lhs = insensitive ? `LOWER(${column})` : column;
  if (operator === "in" || operator === "not_in") {
    if (!Array.isArray(value)) {
      throw new Error(`auth D1 adapter: "${operator}" needs an array value`);
    }
    if (value.length === 0) {
      return operator === "in" ? "0 = 1" : "1 = 1";
    }
    const placeholders = value
      .map((entry) => {
        params.push(insensitive && typeof entry === "string" ? entry.toLowerCase() : entry);
        return "?";
      })
      .join(", ");
    return `${lhs} ${operator === "in" ? "IN" : "NOT IN"} (${placeholders})`;
  }
  if (operator === "contains" || operator === "starts_with" || operator === "ends_with") {
    const text = value == null ? "" : String(value);
    const escaped = text.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_");
    const pattern =
      operator === "contains"
        ? `%${escaped}%`
        : operator === "starts_with"
          ? `${escaped}%`
          : `%${escaped}`;
    params.push(insensitive ? pattern.toLowerCase() : pattern);
    return `${lhs} LIKE ? ESCAPE '\\'`;
  }
  if (value === null) {
    if (operator === "eq") return `${column} IS NULL`;
    if (operator === "ne") return `${column} IS NOT NULL`;
    throw new Error(`auth D1 adapter: null is not valid for operator ${operator}`);
  }
  const sqlOp =
    operator === "eq"
      ? "="
      : operator === "ne"
        ? "<>"
        : operator === "gt"
          ? ">"
          : operator === "gte"
            ? ">="
            : operator === "lt"
              ? "<"
              : operator === "lte"
                ? "<="
                : null;
  if (sqlOp === null) {
    throw new Error(`auth D1 adapter: unsupported where operator ${operator}`);
  }
  params.push(insensitive && typeof value === "string" ? value.toLowerCase() : value);
  return `${lhs} ${sqlOp} ?`;
}

/**
 * Left-associative WHERE so AND/OR match the in-memory adapter's evaluation.
 * @param {Array<{field: string, operator?: string, value?: unknown, connector?: string, mode?: string}>|undefined} where
 * @param {(args: {model: string, field: string}) => string} fieldName
 * @param {string} modelKey
 */
function whereSql(where, fieldName, modelKey) {
  if (where === undefined || where.length === 0) {
    return { sql: "", params: [] };
  }
  /** @type {unknown[]} */
  const params = [];
  let sql = "";
  for (const [index, clause] of where.entries()) {
    const column = ident(fieldName({ model: modelKey, field: clause.field }));
    const piece = `(${predicateSql(column, clause, params)})`;
    if (index === 0) {
      sql = piece;
      continue;
    }
    sql = `(${sql} ${clause.connector === "OR" ? "OR" : "AND"} ${piece})`;
  }
  return { sql: ` WHERE ${sql}`, params };
}

/**
 * @param {(args: {model: string, field: string}) => string} fieldName
 * @param {string} modelKey
 * @param {string[]} [select]
 */
function selectSql(fieldName, modelKey, select) {
  if (select === undefined || select.length === 0) {
    return "*";
  }
  return select.map((field) => ident(fieldName({ model: modelKey, field }))).join(", ");
}

/**
 * @param {D1Database} db
 * @param {string} sql
 * @param {unknown[]} params
 */
async function one(db, sql, params) {
  return first(db, sql, ...params);
}

/**
 * @param {D1Database} db
 * @param {string} sql
 * @param {unknown[]} params
 */
async function many(db, sql, params) {
  return /** @type {Record<string, unknown>[]} */ (await all(db, sql, ...params));
}

/**
 * @template T
 * @param {unknown} value
 * @returns {T}
 */
function asRow(value) {
  return /** @type {T} */ (value);
}

/**
 * @param {D1Database} db
 * @param {string} sql
 * @param {unknown[]} params
 */
async function write(db, sql, params) {
  const result = await run(db, sql, ...params);
  const meta = /** @type {{meta?: {changes?: number}}} */ (result).meta;
  if (meta === undefined || typeof meta.changes !== "number") {
    throw new Error("auth D1 adapter: write returned no change count");
  }
  return meta.changes;
}

/**
 * Follow-up queries for a join. The tables are tiny (session → user), so two
 * statements stay cheaper than shipping Kysely's join compiler.
 * @param {D1Database} db
 * @param {Record<string, unknown>[]} rows
 * @param {Record<string, {on: {from: string, to: string}, relation?: string, limit?: number, modelKey?: string}>|undefined} join
 */
async function attachJoins(db, rows, join) {
  if (join === undefined || rows.length === 0) {
    return rows;
  }
  for (const row of rows) {
    for (const [joinModel, joinAttr] of Object.entries(join)) {
      if (joinAttr.relation === "many-to-many") {
        throw new Error(`auth D1 adapter: many-to-many join on ${joinModel} is not implemented`);
      }
      const from = row[joinAttr.on.from];
      const limit = joinAttr.relation === "one-to-one" ? 1 : (joinAttr.limit ?? 100);
      const related = await many(
        db,
        `SELECT * FROM ${ident(joinModel)} WHERE ${ident(joinAttr.on.to)} = ? LIMIT ?`,
        [from, limit],
      );
      if (joinAttr.relation === "one-to-one") {
        row[joinModel] = related[0] ?? null;
        continue;
      }
      row[joinModel] = related;
    }
  }
  return rows;
}

/**
 * Better Auth adapter over one D1 binding (or the test stand-in that speaks
 * the same prepare/bind/first/all/run shape).
 * @param {D1Database} db
 */
export function d1Adapter(db) {
  return createAdapterFactory({
    config: {
      adapterId: "d1",
      adapterName: "D1 Adapter",
      // Same SQLite flags the Kysely D1 path used: the factory then stores
      // dates as ISO strings and booleans as 0/1, which is what the shipped
      // migrations declare.
      supportsBooleans: false,
      supportsDates: false,
      supportsJSON: false,
      supportsArrays: false,
      supportsUUIDs: false,
      transaction: false,
    },
    adapter: ({ getFieldName }) => ({
      async create({ model, data }) {
        const columns = Object.keys(data);
        if (columns.length === 0) {
          throw new Error(`auth D1 adapter: create on ${model} has no columns`);
        }
        const sql = `INSERT INTO ${ident(model)} (${columns.map(ident).join(", ")}) VALUES (${columns
          .map(() => "?")
          .join(", ")}) RETURNING *`;
        const row = await one(
          db,
          sql,
          columns.map((column) => data[column]),
        );
        if (row === null || row === undefined) {
          throw new Error(`auth D1 adapter: create on ${model} returned no row`);
        }
        return /** @type {typeof data} */ (row);
      },
      async findOne({ model, modelKey = model, where, select, join }) {
        const filter = whereSql(where, getFieldName, modelKey);
        const rows = await many(
          db,
          `SELECT ${selectSql(getFieldName, modelKey, select)} FROM ${ident(model)}${filter.sql} LIMIT 1`,
          filter.params,
        );
        const attached = await attachJoins(db, rows, join);
        return asRow(attached[0] ?? null);
      },
      async findMany({ model, modelKey = model, where, limit, select, offset, sortBy, join }) {
        const filter = whereSql(where, getFieldName, modelKey);
        let sql = `SELECT ${selectSql(getFieldName, modelKey, select)} FROM ${ident(model)}${filter.sql}`;
        /** @type {unknown[]} */
        const params = [...filter.params];
        if (sortBy?.field) {
          const direction = sortBy.direction === "desc" ? "DESC" : "ASC";
          sql += ` ORDER BY ${ident(getFieldName({ model: modelKey, field: sortBy.field }))} ${direction}`;
        }
        if (limit !== undefined) {
          sql += " LIMIT ?";
          params.push(limit);
        } else if (offset !== undefined) {
          sql += " LIMIT -1";
        }
        if (offset !== undefined) {
          sql += " OFFSET ?";
          params.push(offset);
        }
        return asRow(await attachJoins(db, await many(db, sql, params), join));
      },
      async count({ model, modelKey = model, where }) {
        const filter = whereSql(where, getFieldName, modelKey);
        const row = await one(
          db,
          `SELECT COUNT(*) AS n FROM ${ident(model)}${filter.sql}`,
          filter.params,
        );
        const n = /** @type {{n?: unknown}} */ (row)?.n;
        if (typeof n !== "number") {
          throw new Error(`auth D1 adapter: count on ${model} returned ${String(n)}`);
        }
        return n;
      },
      async update({ model, modelKey = model, where, update: values }) {
        if (where.length === 0) {
          return null;
        }
        const record = /** @type {Record<string, unknown>} */ (values);
        const columns = Object.keys(record);
        if (columns.length === 0) {
          return this.findOne({ model, modelKey, where });
        }
        const filter = whereSql(where, getFieldName, modelKey);
        const assignments = columns.map((column) => `${ident(column)} = ?`).join(", ");
        const row = await one(
          db,
          `UPDATE ${ident(model)} SET ${assignments}${filter.sql} RETURNING *`,
          [...columns.map((column) => record[column]), ...filter.params],
        );
        return asRow(row ?? null);
      },
      async updateMany({ model, modelKey = model, where, update: values }) {
        if (where.length === 0) {
          return 0;
        }
        const columns = Object.keys(values);
        if (columns.length === 0) {
          return 0;
        }
        const filter = whereSql(where, getFieldName, modelKey);
        const assignments = columns.map((column) => `${ident(column)} = ?`).join(", ");
        return write(db, `UPDATE ${ident(model)} SET ${assignments}${filter.sql}`, [
          ...columns.map((column) => values[column]),
          ...filter.params,
        ]);
      },
      async delete({ model, modelKey = model, where }) {
        if (where.length === 0) {
          return;
        }
        const filter = whereSql(where, getFieldName, modelKey);
        await write(db, `DELETE FROM ${ident(model)}${filter.sql}`, filter.params);
      },
      async deleteMany({ model, modelKey = model, where }) {
        if (where.length === 0) {
          return 0;
        }
        const filter = whereSql(where, getFieldName, modelKey);
        return write(db, `DELETE FROM ${ident(model)}${filter.sql}`, filter.params);
      },
      async consumeOne({ model, modelKey = model, where }) {
        const idField = ident(getFieldName({ model: modelKey, field: "id" }));
        const filter = whereSql(where, getFieldName, modelKey);
        return asRow(
          await one(
            db,
            `DELETE FROM ${ident(model)} WHERE ${idField} IN (SELECT ${idField} FROM ${ident(model)}${filter.sql} ORDER BY ${idField} LIMIT 1) RETURNING *`,
            filter.params,
          ),
        );
      },
      async incrementOne({ model, modelKey = model, where, increment, set }) {
        const idField = ident(getFieldName({ model: modelKey, field: "id" }));
        const filter = whereSql(where, getFieldName, modelKey);
        /** @type {unknown[]} */
        const params = [];
        const assignments = [];
        for (const [field, delta] of Object.entries(increment)) {
          const column = ident(field);
          assignments.push(`${column} = ${column} + ?`);
          params.push(delta);
        }
        if (set !== undefined) {
          for (const [field, value] of Object.entries(set)) {
            assignments.push(`${ident(field)} = ?`);
            params.push(value);
          }
        }
        if (assignments.length === 0) {
          return this.findOne({ model, modelKey, where });
        }
        params.push(...filter.params);
        return asRow(
          await one(
            db,
            `UPDATE ${ident(model)} SET ${assignments.join(", ")} WHERE ${idField} IN (SELECT ${idField} FROM ${ident(model)}${filter.sql} LIMIT 1) RETURNING *`,
            params,
          ),
        );
      },
    }),
  });
}
