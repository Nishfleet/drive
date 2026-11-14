import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { test } from "node:test";
import { INSTALL_LINES } from "../core/install-lines.js";

/** @param {string} path */
const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

const cfg = read(".goreleaser.yaml");

/**
 * The three pasted install lines .goreleaser.yaml actually publishes.
 * Homebrew: owner/homebrew-tap plus cask name → `brew install owner/tap/name`.
 * nfpm: package_name plus deb/rpm formats → `sudo apt|dnf install ./name_*.deb|rpm`.
 * @param {string} yaml
 */
function installLinesFromGoreleaser(yaml) {
  const casks = yaml.slice(yaml.indexOf("\nhomebrew_casks:"));
  const owner = /repository:\n\s+owner:\s+(\S+)/.exec(casks)?.[1];
  const repo = /repository:\n\s+owner:\s+\S+\n\s+name:\s+(\S+)/.exec(casks)?.[1];
  const cask = /homebrew_casks:\n\s+- name:\s+(\S+)/.exec(yaml)?.[1];
  assert.ok(owner && repo && cask, "homebrew_casks must name the tap and the cask");
  assert.ok(repo.startsWith("homebrew-"), `tap repo ${repo} must be homebrew-<name>`);
  const tap = `${owner}/${repo.slice("homebrew-".length)}`;

  const nfpms = yaml.slice(yaml.indexOf("\nnfpms:"), yaml.indexOf("\nhomebrew_casks:"));
  const pkg = /package_name:\s+(\S+)/.exec(nfpms)?.[1];
  const formats = /formats:\s*\[([^\]]+)\]/.exec(nfpms)?.[1] ?? "";
  assert.ok(pkg, "nfpms must name package_name");
  assert.ok(/\bdeb\b/.test(formats) && /\brpm\b/.test(formats), "nfpms must build deb and rpm");

  return [
    { os: "macOS", line: `brew install ${tap}/${cask}` },
    { os: "Linux, Debian or Ubuntu", line: `sudo apt install ./${pkg}_*.deb` },
    { os: "Linux, Fedora or RHEL", line: `sudo dnf install ./${pkg}_*.rpm` },
  ];
}

test("the package homepage is the one site address", () => {
  const origin = JSON.parse(read("cmd/drive/site.json")).origin;
  const homepages = [...cfg.matchAll(/^\s+homepage:\s+(\S+)/gm)].map((match) => match[1]);
  assert.ok(homepages.length >= 2, "nfpm and the Homebrew cask both name a homepage");
  for (const url of homepages) {
    assert.equal(url, origin, `.goreleaser.yaml homepage ${url} must be cmd/drive/site.json`);
  }
});

test("no install script is added to the tree", () => {
  assert.doesNotMatch(
    cfg,
    /install\.sh|scripts\//,
    "the one-line install is the package manager, not a script",
  );
});

test("install lines in the docs, help and page are generated from .goreleaser.yaml", () => {
  const derived = installLinesFromGoreleaser(cfg);
  assert.deepEqual(
    INSTALL_LINES.map((row) => ({ os: row.os, line: row.line })),
    derived,
    "core/install-lines.js must match .goreleaser.yaml",
  );

  const mainGo = read("cmd/drive/main.go");
  const updateGo = read("cmd/drive/update.go");
  const quickstart = read("docs-site/quickstart.md");
  const docsJs = read("src/docs.js");
  for (const row of derived) {
    assert.ok(mainGo.includes(row.line), `cmd/drive/main.go help must show ${row.line}`);
    assert.ok(
      updateGo.includes(row.line),
      `cmd/drive/update.go must name ${row.line} when the install route is unknown`,
    );
  }
  assert.match(
    quickstart,
    /\{\{INSTALL_MACOS\}\}/,
    "quickstart renders the macOS line from goreleaser",
  );
  assert.match(
    quickstart,
    /\{\{INSTALL_DEBIAN\}\}/,
    "quickstart renders the Debian line from goreleaser",
  );
  assert.match(
    quickstart,
    /\{\{INSTALL_FEDORA\}\}/,
    "quickstart renders the Fedora line from goreleaser",
  );
  assert.match(docsJs, /INSTALL_MACOS: INSTALL_LINES\[0\]\.line/);
  assert.match(docsJs, /INSTALL_DEBIAN: INSTALL_LINES\[1\]\.line/);
  assert.match(docsJs, /INSTALL_FEDORA: INSTALL_LINES\[2\]\.line/);
});

test("the release workflow pins the same goreleaser-action ci.yml pins, and the installed copy matches", () => {
  const release = read("installer/release.yml");
  const ci = read(".github/workflows/ci.yml");
  // The two files must pin the same goreleaser-action, so one cannot drift
  // behind a bump the other got.
  const action = /goreleaser\/goreleaser-action@([0-9a-f]{40})/.exec(ci);
  assert.ok(action, "ci.yml pins goreleaser-action by SHA");
  assert.ok(
    release.includes(`goreleaser/goreleaser-action@${action[1]}`),
    "installer/release.yml must pin the same goreleaser-action SHA ci.yml already uses",
  );
  // A worker token cannot create .github/workflows/release.yml (fleet-ops#105).
  // Once a coordinator copies it, the two files must stay the same.
  if (existsSync(new URL("../.github/workflows/release.yml", import.meta.url))) {
    assert.equal(
      read(".github/workflows/release.yml"),
      release,
      ".github/workflows/release.yml must match installer/release.yml",
    );
  }
});
