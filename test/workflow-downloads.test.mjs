// Every release asset a workflow downloads is checked against a pinned
// SHA-256 digest before it runs (drive#581). This fails on a workflow step
// that downloads a file with curl or Invoke-WebRequest and has no digest check
// in that same step, so a new unpinned download cannot reach main unseen.
// A curl that only reads a status code (`-o /dev/null`) downloads nothing to
// run, so it is not a download here. docs/security.md lists each pin.

import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { test } from "node:test";

const dir = new URL("../.github/workflows/", import.meta.url);
const workflows = readdirSync(dir)
  .filter((name) => /\.ya?ml$/.test(name))
  .map((name) => ({ name, text: readFileSync(new URL(name, dir), "utf8") }));

// A line that saves a remote file: curl with -o/-O (any flag cluster that
// carries one) or PowerShell's Invoke-WebRequest -OutFile.
const DOWNLOAD =
  /\bcurl(?:\.exe)?\b(?=[^\n]*\s-(?:[a-zA-Z]*[oO][a-zA-Z]*|-output|-remote-name)\b)(?![^\n]*-o\s+\/dev\/null)|\bInvoke-WebRequest\b[^\n]*-OutFile\b/;
// A digest check in the same step: sha256sum -c, or Get-FileHash compared to
// a pinned value.
const CHECK = /sha256sum\s+(?:-c|--check)\b|Get-FileHash\b[^\n]*-Algorithm\s+SHA256/;

/**
 * The steps of a workflow, each as its text, split at every `- ` list item
 * that opens a step (`- name:`, `- run:`, `- uses:`).
 * @param {string} text
 */
function steps(text) {
  return text.split(/\n(?=\s*- (?:name|run|uses|id|if|shell|env):)/);
}

/** @param {string} text */
function unpinnedDownloads(text) {
  return steps(text)
    .filter((step) => DOWNLOAD.test(step) && !CHECK.test(step))
    .map((step) =>
      step
        .split("\n")
        .find((line) => DOWNLOAD.test(line))
        ?.trim(),
    );
}

test("every workflow download is checked against a pinned digest in the same step", () => {
  for (const { name, text } of workflows) {
    assert.deepEqual(unpinnedDownloads(text), [], `${name} downloads without a digest check`);
  }
});

test("the gate catches an unpinned download and passes a pinned one", () => {
  const unpinned = [
    "      - name: get rclone",
    "        run: curl -fsSO https://downloads.rclone.org/rclone-current-linux-amd64.zip",
    "      - name: get winfsp",
    "        run: |",
    "          Invoke-WebRequest -Uri $asset.browser_download_url -OutFile winfsp.msi",
    "      - name: get a tool",
    "        run: curl -fsSL -o tool.tgz https://example.com/tool.tgz",
  ].join("\n");
  assert.equal(unpinnedDownloads(unpinned).length, 3);

  const pinned = [
    "      - name: get rclone",
    "        run: |",
    '          curl -fsSO "https://downloads.rclone.org/$V/$zip"',
    '          echo "$SHA  $zip" | sha256sum -c -',
    "      - name: get winfsp",
    "        run: |",
    "          Invoke-WebRequest -Uri $env:URL -OutFile winfsp.msi",
    "          $got = (Get-FileHash -Path winfsp.msi -Algorithm SHA256).Hash.ToLower()",
    "      - name: probe",
    "        run: out=$(curl -s -o /dev/null -w '%{http_code}' https://example.com/)",
  ].join("\n");
  assert.deepEqual(unpinnedDownloads(pinned), []);
});

test("no workflow asks a release API for whatever is newest", () => {
  for (const { name, text } of workflows) {
    assert.doesNotMatch(
      text,
      /releases\/latest|-current-/,
      `${name} downloads an unpinned release`,
    );
  }
});
