// The docs state what the storage provider really enforces on a key, not
// only what the api Worker's capability table grants (drive#502).
//
// On iDrive e2 an agent key is minted with `disable_delete_object: false`, so
// its delete succeeds and leaves a delete marker. The hidden copy behind it is
// kept HIDDEN_VERSION_DAYS and then removed by the bucket's lifecycle rule.
// And iDrive limits a key to a whole bucket, never a folder, so a branch key
// reaches the whole account. These tests tie every page sentence about agent
// deletes and branch reach to those switches, so a page cannot say "agents
// cannot delete" or "a branch key cannot reach your other files" while the
// mint says otherwise, and the sentences change by themselves the day the
// mint does.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { createIdriveKeyProvider, deleteSwitchesFor } from "../core/idrive-keys.js";
import { CAPABILITIES_BY_KIND } from "../core/keyprovider.js";
import { HIDDEN_VERSION_DAYS } from "../core/s3.js";
import { agentDeleteSentence, branchReachSentence, KEY_TABLE } from "../src/docs.js";
import { STORAGE_POWERS } from "../src/keys.js";

/** @param {string} path */
const readRepo = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
/** @param {string} name */
const shipped = (name) => readRepo(`public/docs/${name}`);

// Every place a person or an agent reads the claims.
const PAGES = ["agents.md", "security.md", "limits.md", "how-it-works.md", "faq.md"];
const README = readRepo("README.md");

test("the mint sends exactly the switches the docs read", async () => {
  /** @type {Array<Record<string, unknown>>} */
  const bodies = [];
  const provider = createIdriveKeyProvider({
    apiEndpoint: "https://e2.example/api/reseller/v1",
    apiToken: "test-token",
    fetchImpl: async (_url, init) => {
      bodies.push(JSON.parse(String(init?.body)));
      return new Response(JSON.stringify({ access_key_id: "ak", secret_access_key: "sk" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  });
  for (const kind of /** @type {const} */ (["device", "agent", "branch"])) {
    bodies.length = 0;
    const capabilities = CAPABILITIES_BY_KIND[kind];
    await provider.mint({ prefix: "u/acct/", capabilities, bucket: "drv-acct" });
    assert.equal(bodies.length, 1, `one mint call for ${kind}`);
    for (const [name, value] of Object.entries(deleteSwitchesFor(capabilities))) {
      assert.equal(bodies[0][name], value, `${kind} key: ${name}`);
    }
  }
});

test("the storage powers follow the switches and the hidden-version rule", () => {
  // The facts drive#502 found, pinned. If a real-account run proves iDrive
  // honours disable_delete_object and the mint turns it on, this test fails
  // and the docs sentences below change with the switch.
  assert.equal(STORAGE_POWERS.agent.canDelete, true);
  assert.equal(STORAGE_POWERS.agent.canDestroyHidden, false);
  assert.equal(STORAGE_POWERS.agent.undoDays, HIDDEN_VERSION_DAYS);
  assert.equal(STORAGE_POWERS.branch.reachesWholeDrive, true);
  assert.equal(STORAGE_POWERS.device.canDestroyHidden, true);
});

test("no page says an agent cannot delete or a branch key is fenced in", () => {
  const sentence = agentDeleteSentence();
  const reach = branchReachSentence();
  for (const name of PAGES) {
    const page = shipped(name);
    if (STORAGE_POWERS.agent.canDelete) {
      assert.doesNotMatch(
        page,
        /agents? (keys? )?(cannot|can never|can't) (delete|remove)|cannot wipe|cannot remove anything|cannot delete at all/i,
        `${name} claims an agent cannot delete, but the storage takes its delete`,
      );
    }
    if (STORAGE_POWERS.branch.reachesWholeDrive) {
      assert.doesNotMatch(
        page,
        /cannot reach your other files|other files are outside its reach/i,
        `${name} claims a branch key is fenced in, but the storage limits a key to the whole bucket`,
      );
    }
  }
  for (const name of ["agents.md", "security.md", "limits.md", "how-it-works.md"]) {
    assert.ok(shipped(name).includes(sentence), `${name} states what an agent's delete does`);
  }
  for (const name of ["agents.md", "security.md", "limits.md"]) {
    assert.ok(shipped(name).includes(reach), `${name} states how far a branch key reaches`);
  }
  assert.ok(shipped("faq.md").includes(sentence), "the FAQ states what an agent's delete does");
});

test("the key table shows the real delete and reach for each key", () => {
  const rows = KEY_TABLE.split("\n");
  const row = (/** @type {string} */ kind) => rows.find((line) => line.startsWith(`| ${kind} |`));
  assert.match(String(row("agent")), new RegExp(`yes, undoable for ${HIDDEN_VERSION_DAYS} day`));
  assert.match(String(row("branch")), /your whole Storagebun \|$/);
  for (const name of ["agents.md", "security.md"]) {
    assert.ok(shipped(name).includes(String(row("agent"))), `${name} carries the key table`);
  }
});

test("the README says the same as the docs", () => {
  assert.doesNotMatch(README, /Agents cannot delete|that key cannot\s+remove a file/);
  assert.ok(
    README.includes(`undoable for ${HIDDEN_VERSION_DAYS} day`),
    "the README states the undo window",
  );
  assert.match(README, /branch key\s+reaches your whole Drive/);
});
