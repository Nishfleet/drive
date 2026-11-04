import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { test } from "node:test";

/** @param {string} path */
const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

test("a FUSE skip is a failure under CI=true (drive#501)", () => {
  const e2e = read("cmd/drive/e2e_test.go");
  assert.match(e2e, /func skipNoMount\(/, "one helper owns the skip-or-fail choice");
  assert.match(e2e, /os\.Getenv\("CI"\) == "true"/, "the helper fails only for CI=true");
  assert.match(e2e, /a FUSE skip is a failure under CI=true/, "the failure names the rule");
  const logout = read("cmd/drive/logout_test.go");
  assert.match(
    logout,
    /if testing\.Short\(\) && os\.Getenv\("CI"\) != "true" \{/,
    "TestLogoutStopsALiveMount still runs under CI=true in the -short unit tests",
  );
});

test("a skip of a proof this runner can run is a failure under CI=true (drive#582)", async () => {
  const testDir = new URL("../test/", import.meta.url);
  const writers = readdirSync(testDir)
    .filter((name) => name.endsWith(".mjs") && name !== "proof-skip.mjs")
    .filter((name) => name !== "proof-skip.test.mjs")
    .filter((name) => read(`test/${name}`).includes('from "./proof-skip.mjs"'))
    .map((name) => `test/${name}`)
    .sort();
  assert.deepEqual(
    writers,
    [
      "test/cap-mount.test.mjs",
      "test/files-page-click.test.mjs",
      "test/home-demos.test.mjs",
      "test/speed-ratchet.test.mjs",
      "test/step1-storage.test.mjs",
      "test/step5-meter-standin.test.mjs",
    ],
    "every proof that imports the one skip report is scanned here, so a sixth proof joins this gate before it ships",
  );
  for (const file of writers) {
    assert.doesNotMatch(
      read(file),
      /function reportSkip\(/,
      `${file} carries no skip guard of its own`,
    );
  }
  const gated = ["chrome-file-click", "s3-standin", "cap-mount-rclone", "speed-ratchet-cli"];
  const ungated = ["cap-mount", "home-page-demos"];
  const reported = new Set();
  for (const file of writers) {
    for (const found of read(file).matchAll(/reportSkip\("([^"]+)"/g)) {
      reported.add(found[1]);
    }
  }
  for (const name of [...gated, ...ungated]) {
    assert.ok(reported.has(name), `${name} is a name a proof actually reports`);
  }
  assert.deepEqual(
    [...reported].sort(),
    [...gated, ...ungated].sort(),
    "every name a proof reports is on the gated list or on the cannot-run list, so the next silent skip is caught here",
  );

  const { reportSkip } = await import("../test/proof-skip.mjs");
  const previousCi = process.env.CI;
  const previousReport = process.env.DRIVE_PROOF_REPORT;
  const report = new URL("./skip-report.txt", import.meta.url);
  /** @type {string[]} */
  const printed = [];
  const write = process.stdout.write.bind(process.stdout);
  /**
   * @param {string} chunk
   * @returns {boolean}
   */
  const capture = (chunk) => {
    printed.push(chunk);
    return true;
  };
  try {
    process.env.CI = "true";
    delete process.env.DRIVE_PROOF_REPORT;
    process.stdout.write = capture;
    for (const name of gated) {
      assert.throws(
        () => reportSkip(name, "the tool is not installed"),
        (err) => err instanceof Error && err.message.startsWith(`${name} skipped under CI=true`),
        `${name} is a failure under CI=true`,
      );
    }
    for (const name of ungated) {
      assert.equal(
        process.env.DRIVE_PROOF_REPORT,
        undefined,
        "the ambient proof report is unset while the ungated skips run, so a skip this test makes cannot reach the caller's real report",
      );
      assert.doesNotThrow(
        () => reportSkip(name, "the runner cannot do this"),
        `${name} still skips, because this runner cannot run it`,
      );
    }
    process.env.CI = "";
    process.env.DRIVE_PROOF_REPORT = report.pathname;
    reportSkip(ungated[0], "the runner cannot do this");
    assert.equal(
      readFileSync(report, "utf8"),
      `${ungated[0]}: the runner cannot do this\n`,
      "a skip outside CI still records one line when the caller asks for it",
    );
  } finally {
    process.stdout.write = write;
    process.env.CI = previousCi ?? "";
    if (previousReport === undefined) delete process.env.DRIVE_PROOF_REPORT;
    else process.env.DRIVE_PROOF_REPORT = previousReport;
    await rm(report, { force: true });
  }
  assert.deepEqual(
    printed.filter((line) => line !== "\n"),
    [
      ...ungated.map((name) => `proof skipped: ${name}: the runner cannot do this\n`),
      `proof skipped: ${ungated[0]}: the runner cannot do this\n`,
    ],
    "a gated name prints nothing and throws, and every skip that is allowed prints its name and reason, so CI's log carries the count per named proof",
  );
});
