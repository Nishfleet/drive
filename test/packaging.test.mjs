// The one-line install (drive issue #105 / #509), checked here rather than
// trusted.
//
// GoReleaser builds the .deb, the .rpm and the Homebrew cask. The issue's
// promise is that those packages depend on rclone, so one `apt install`,
// `dnf install` or `brew install` brings the CLI and rclone together. This
// file matches that promise against `.goreleaser.yaml`, so a later edit that
// drops the dependency fails the suite instead of shipping a package that
// installs drive alone.
//
// drive#509: the pasted install lines in the docs, the CLI help and the
// get-started page are generated from this same YAML. A short `brew install
// drive` cannot resolve after a release; the derived lines are the ones that
// can.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { INSTALL_LINES } from "../src/install-lines.js";

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

test("the Linux packages depend on rclone", () => {
  const nfpms = cfg.slice(cfg.indexOf("\nnfpms:"), cfg.indexOf("\nhomebrew_casks:"));
  assert.match(nfpms, /formats: \[deb, rpm\]/, "GoReleaser builds both Linux packages");
  assert.match(
    nfpms,
    /^\s+dependencies:\n\s+- rclone$/m,
    "Depends: rclone is the one-command install",
  );
});

test("the Homebrew cask depends on rclone", () => {
  const casks = cfg.slice(cfg.indexOf("\nhomebrew_casks:"));
  assert.match(casks, /name: drive/, "the cask is named drive");
  assert.match(
    casks,
    /dependencies:\n\s+- formula: rclone/,
    "brew install nish3451/tap/drive also installs rclone",
  );
  assert.doesNotMatch(
    cfg,
    /^brews:/m,
    "the deprecated brews block is gone; goreleaser check fails on it",
  );
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
    "src/install-lines.js must match .goreleaser.yaml",
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

test("the release workflow on v* tags runs stock goreleaser with signing and notarize blocks", () => {
  const release = read(".github/workflows/release.yml");
  const ci = read(".github/workflows/ci.yml");
  assert.match(release, /tags:\n\s+- "v\*"/, "a v* tag starts the release");
  assert.match(release, /^\s+distribution: goreleaser$/m, "stock goreleaser, not goreleaser-pro");
  assert.match(release, /name: Import GPG key/, "the workflow has its own signing block");
  assert.match(release, /--skip=sign/, "unsigned pre-releases skip GPG when the key is missing");
  assert.match(release, /MACOS_NOTARY_ISSUER_ID/, "notarize env is the stock goreleaser names");
  assert.match(cfg, /^signs:/m, ".goreleaser.yaml signs checksums when a key exists");
  assert.match(cfg, /^notarize:/m, ".goreleaser.yaml notarize stays off until NOTARIZE=true");
  const action = /goreleaser\/goreleaser-action@([0-9a-f]{40})/.exec(ci);
  assert.ok(action, "ci.yml pins goreleaser-action by SHA");
  assert.ok(
    release.includes(`goreleaser/goreleaser-action@${action[1]}`),
    "release.yml must pin the same goreleaser-action SHA ci.yml already uses",
  );
  assert.match(release, /cache: false/, "a publishing job must not reuse a Go module cache");
});
