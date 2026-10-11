// The meter's binding parity, pinned (drive issue #735).
//
// The hourly meter trip carries two names on env for one database: METER_DB
// carries the meter's own tables and DRIVE_DB carries the file index and the
// pre-charge sweep drive#536 added. test/abuse-guards.test.mjs pins the trip
// to both bindings, and the trip fails closed with a retry when DRIVE_DB is
// absent, because a trip that skipped the sweep would report the hour rolled
// with every over-limit account still writing through its key.
//
// That the two names bind the same database is why that guard never fires in
// production: cloudflare.config.ts binds both to the one drive-data database
// (drive issue #6, "same database, so same id"), so the file index, the meter's
// ledger and the sweep all read one set of rows. The parity lived only as prose
// — the config's own comment and the comments on two test stubs
// (test/dodo.test.mjs, and test/meter-scale.test.mjs since drive#734). Nothing
// read any of it. An edit that gave one name a database of its own would have
// been green everywhere while splitting the meter's ledger from the file index
// it bills, and the deploy would have carried a meter that reads nothing.
//
// This file is the gate on that prose. It reads cloudflare.config.ts the way
// test/deploy-secrets.test.mjs does, and asserts the two d1 bindings share one
// id, so the silent split is a red test rather than a comment nobody grep'd.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

/** @param {string} path */
const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

// The site Worker's config cannot be imported here: it anchors its entrypoint
// through the `with { type: "cf-worker" }` attribute, which Node rejects with
// ERR_IMPORT_ATTRIBUTE_UNSUPPORTED and only cf's own loader handles (see the
// header of test/deploy-api-worker.test.mjs, drive#341). So this reads the same
// text the deploy uploads, the way test/deploy-secrets.test.mjs reads it.
//
// Each binding is matched from its opening brace to the first closing one
// (`[^}]*`), not by a whole-line pattern, so the `name` and the `id` lines may
// be reordered, re-indented or split across lines without turning the gate into
// a formatting check. A d1 body that grows a nested object is a config change
// this would stop reading, and that failure names the binding it could not read
// rather than passing on a half of it. A binding that declares one field and not
// the other fails the same way, because a half-declared binding is the case an
// edit makes by hand.
//
// The name has to start a line (`^`) for the match to count. A d1 block written
// out in prose — a comment that shows the wrong way to bind a name — is the one
// shape that otherwise wins: the regex would read the example as the binding
// and this map would hold the decoy under the real name, so the parity below
// would compare a comment against a deploy.
//
// Each field is anchored to an object separator (`{` or `,`), so a longer field
// name that contains `name` or `id` — `database_name:`, `preview_database_id:` —
// cannot be read as the plain field.
/** @typedef {{name: string, id: string}} D1Binding */

/**
 * @param {string} text a worker config's source
 * @returns {Map<string, D1Binding>} the d1 bindings it declares, by the name it
 * binds them under
 */
const d1Bindings = (text) => {
  /** @type {Map<string, D1Binding>} */
  const found = new Map();
  const bindings = text.matchAll(/^[ \t]*(\w+)[ \t]*:[ \t]*bindings\.d1\((\{[^}]*\})/gm);
  for (const [, binding, body] of bindings) {
    const name = /[{,]\s*name:\s*"([^"]+)"/.exec(body)?.[1];
    const id = /[{,]\s*id:\s*"([^"]+)"/.exec(body)?.[1];
    assert.ok(
      name !== undefined && id !== undefined,
      `${binding} is a d1 binding whose body names no database: ${body.trim()}`,
    );
    found.set(binding, { name, id });
  }
  return found;
};

/**
 * @returns {Map<string, D1Binding>} the d1 bindings the deploy's config declares
 */
const declaredD1Bindings = () => d1Bindings(read("cloudflare.config.ts"));

/**
 * @param {Map<string, D1Binding>} bindings
 * @param {string} name the binding name to read
 * @returns {D1Binding}
 */
function binding(bindings, name) {
  const declared = bindings.get(name);
  assert.ok(
    declared,
    `cloudflare.config.ts must declare ${name} as a d1 binding, found ${[...bindings.keys()].join(", ")}`,
  );
  return declared;
}

// A Cloudflare d1 id is a UUID. Both halves of the parity are checked against
// the one shape, so two empty strings or two placeholders cannot pass as a
// pair either.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

test("the meter and the file index bind the same database", () => {
  // The parity the issue names: the meter's ledger and the file index the
  // sweep reads are one database, so the drive#536 guard's DRIVE_DB is the
  // database the meter already writes to and a production trip never fails the
  // binding check. A rebind of either name to a database of its own is a red
  // test here, and the message says which side moved.
  const declared = declaredD1Bindings();
  const drive = binding(declared, "DRIVE_DB");
  const meter = binding(declared, "METER_DB");
  assert.ok(
    UUID.test(drive.id),
    `DRIVE_DB binds id "${drive.id}", which is not a Cloudflare d1 id`,
  );
  assert.ok(
    UUID.test(meter.id),
    `METER_DB binds id "${meter.id}", which is not a Cloudflare d1 id`,
  );
  assert.equal(
    meter.id,
    drive.id,
    `METER_DB binds database "${meter.name}" (${meter.id}) and DRIVE_DB binds "${drive.name}" (${drive.id}). The hourly trip reads METER_DB for its own tables and DRIVE_DB for the file index and the drive#536 pre-charge sweep, so two databases split the meter's ledger from the rows it bills and make the sweep fail closed on every hourly trip. Bind both names to the one database, as drive issue #6 does.`,
  );
  assert.equal(
    meter.name,
    drive.name,
    `METER_DB and DRIVE_DB bind different database names ("${meter.name}" and "${drive.name}") on the same id; name them the same database so the config says what the deploy binds.`,
  );
});

test("a commented-out example does not win over the live binding", () => {
  // The one shape the parse has to refuse: a comment that writes a d1 block
  // out in prose. METER_DB's own comment block is where a split would be
  // explained, so the decoy is written the way that explanation would write it,
  // and the map this reads must still hold the database the deploy binds.
  const withDecoy = `
${read("cloudflare.config.ts")}
// A third way to split the meter, do not do this:
//   METER_DB: bindings.d1({
//     name: "meter-of-its-own",
//     id: "11111111-2222-3333-4444-555555555555",
//   }),
`;
  const declared = d1Bindings(withDecoy);
  const meter = binding(declared, "METER_DB");
  const drive = binding(declared, "DRIVE_DB");
  assert.equal(meter.id, drive.id, "the live METER_DB binding is the one the gate reads");
  assert.equal(meter.name, drive.name, "the live METER_DB binding is the one the gate reads");
  // The decoy parsed as a binding would sit under METER_DB's name and overwrite
  // the live entry, so asserting its id is absent from every parsed binding is
  // what says the comment lost. A fourth d1 binding added to the config later
  // does not fail this line, which a count of the parsed bindings would.
  const decoyId = "11111111-2222-3333-4444-555555555555";
  assert.ok(
    ![...declared.values()].some((entry) => entry.id === decoyId),
    `the decoy's id ${decoyId} is parsed as a real binding`,
  );
});

test("the waitlist keeps its own database, so the parity is a rule and not a coincidence", () => {
  // The other half of the same rule (drive issue #170): the sign-up list is
  // public data that can be reset or exported without touching a customer's
  // files, so the config's three d1 bindings are two databases on purpose. This
  // is what makes the assertion above mean something — the gate is not "every
  // binding is one database", it is "these two names are".
  const declared = declaredD1Bindings();
  const drive = binding(declared, "DRIVE_DB");
  const waitlist = binding(declared, "WAITLIST_DB");
  assert.notEqual(
    waitlist.id,
    drive.id,
    `WAITLIST_DB and DRIVE_DB both bind ${drive.id}: the waitlist's sign-up list is public data and a customer's files are not, so they belong to separate databases (drive issue #170).`,
  );
  assert.notEqual(
    waitlist.name,
    drive.name,
    `WAITLIST_DB is named "${waitlist.name}", the same as DRIVE_DB; name the waitlist database after itself.`,
  );
});
