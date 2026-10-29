import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { test } from "node:test";

const dir = new URL("../.github/workflows/", import.meta.url);
const workflows = readdirSync(dir)
  .filter((name) => /\.ya?ml$/.test(name))
  .map((name) => ({ name, text: readFileSync(new URL(name, dir), "utf8") }));

// A composite action a workflow calls is part of that workflow: the job runs
// its steps, so a download it makes is a workflow download. The rclone
// install lives in .github/actions/rclone, so the gate follows it there.
const actionsDir = new URL("../.github/actions/", import.meta.url);
const actions = existsSync(actionsDir)
  ? readdirSync(actionsDir, { recursive: true, encoding: "utf8" })
      .filter((name) => statSync(new URL(name, actionsDir)).isFile())
      .map((name) => ({ name, text: readFileSync(new URL(name, actionsDir), "utf8") }))
  : [];
const files = [...workflows, ...actions];

// A line that fetches a remote file to keep or run: wget; curl with -o/-O
// (any flag cluster that carries one), or curl redirected to a file or piped
// into another program; PowerShell's Invoke-WebRequest -OutFile.
const DOWNLOAD = new RegExp(
  [
    String.raw`\bwget\b`,
    String.raw`\bcurl(?:\.exe)?\b(?=[^\n]*\s-(?:[a-zA-Z]*[oO][a-zA-Z]*|-output|-remote-name)\b)(?![^\n]*-o\s+\/dev\/null)`,
    String.raw`\bcurl(?:\.exe)?\b[^\n|>]*(?:\||>(?!\s*\/dev\/null))`,
    String.raw`\bInvoke-WebRequest\b[^\n]*-OutFile\b`,
  ].join("|"),
  "g",
);
// A digest check against a value pinned in this repository: `sha256sum -c`
// fed by an env value named *_SHA256, or a Get-FileHash result compared with
// one. A hash that is computed and never compared is not a check.
const CHECK = new RegExp(
  [
    String.raw`echo\s+"\$\{?\w*_SHA256\b[^\n]*\|\s*sha256sum\s+(?:-c|--check)\b`,
    String.raw`-ne\s+(?:\$env:\w*_SHA256\b|"\$\{\{\s*env\.\w*_SHA256\s*\}\}")`,
  ].join("|"),
  "g",
);

/**
 * The steps of a workflow, each as its text, split at every `- ` list item
 * that opens a step (`- name:`, `- run:`, `- uses:`).
 * @param {string} text
 */
function steps(text) {
  return text.split(/\n(?=\s*- (?:name|run|uses|id|if|shell|env):)/);
}

// A step may carry one download, and it passes only with a pinned check.
// Counting checks against downloads is not enough: two checks of one file
// would cover a second, unchecked download. So a step with two downloads
// fails, and a second download goes in its own step with its own check.
/** @param {string} step */
function unpinned(step) {
  const downloads = (step.match(DOWNLOAD) ?? []).length;
  return downloads > 1 || (downloads === 1 && !new RegExp(CHECK.source).test(step));
}

/** @param {string} text */
function unpinnedDownloads(text) {
  return steps(text)
    .filter(unpinned)
    .map((step) =>
      step
        .split("\n")
        .find((line) => new RegExp(DOWNLOAD.source).test(line))
        ?.trim(),
    );
}

test("every workflow download is checked against a pinned digest in the same step", () => {
  for (const { name, text } of files) {
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
    "      - name: pipe a tool",
    "        run: curl -fsSL https://example.com/tool.tgz | tar xz",
    "      - name: redirect a tool",
    "        run: curl -fsSL https://example.com/tool > tool",
    "      - name: wget a tool",
    "        run: wget https://example.com/tool.tgz",
    "      - name: hash but never compare",
    "        run: |",
    "          Invoke-WebRequest -Uri $env:URL -OutFile winfsp.msi",
    "          $got = (Get-FileHash -Path winfsp.msi -Algorithm SHA256).Hash.ToLower()",
    "      - name: one checked, one not",
    "        run: |",
    '          curl -fsSO "https://downloads.rclone.org/$V/$zip"',
    '          echo "$PINNED_SHA256  $zip" | sha256sum -c -',
    "          curl -fsSLO https://example.com/other.zip",
    "      - name: two checks, one of them for an unchecked second file",
    "        run: |",
    '          curl -fsSO "https://downloads.rclone.org/$V/$zip"',
    '          echo "$PINNED_SHA256  $zip" | sha256sum -c -',
    '          echo "$PINNED_SHA256  $zip" | sha256sum -c -',
    "          curl -fsSLO https://example.com/other.zip",
  ].join("\n");
  assert.equal(unpinnedDownloads(unpinned).length, 9);

  const pinned = [
    "      - name: get rclone",
    "        run: |",
    '          curl -fsSO "https://downloads.rclone.org/$V/$zip"',
    '          echo "$PINNED_SHA256  $zip" | sha256sum -c -',
    "      - name: get winfsp",
    "        run: |",
    "          Invoke-WebRequest -Uri $env:URL -OutFile winfsp.msi",
    "          $got = (Get-FileHash -Path winfsp.msi -Algorithm SHA256).Hash.ToLower()",
    "          if ($got -ne $env:WINFSP_MSI_SHA256) { throw 'digest' }",
    "      - name: get winfsp, env expression",
    "        run: |",
    `          Invoke-WebRequest -Uri "\${{ env.URL }}" -OutFile winfsp.msi`,
    "          $got = (Get-FileHash -Path winfsp.msi -Algorithm SHA256).Hash.ToLower()",
    `          if ($got -ne "\${{ env.WINFSP_MSI_SHA256 }}") {`,
    "      - name: probe",
    "        run: out=$(curl -s -o /dev/null -w '%{http_code}' https://example.com/)",
  ].join("\n");
  assert.deepEqual(unpinnedDownloads(pinned), []);
});

test("no workflow asks a release API for whatever is newest", () => {
  for (const { name, text } of files) {
    assert.doesNotMatch(
      text,
      /releases\/latest|-current-/,
      `${name} downloads an unpinned release`,
    );
  }
});
