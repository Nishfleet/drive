// The one-line install (drive issue #105), checked here rather than trusted.
//
// GoReleaser builds the .deb, the .rpm and the Homebrew formula. The issue's
// promise is that those packages depend on rclone, so one `apt install`,
// `dnf install` or `brew install` brings the CLI and rclone together. This
// file matches that promise against `.goreleaser.yaml`, so a later edit that
// drops the dependency fails the suite instead of shipping a package that
// installs drive alone.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

/** @param {string} path */
const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

const cfg = read(".goreleaser.yaml");

test("the Linux packages depend on rclone", () => {
  const nfpms = cfg.slice(cfg.indexOf("\nnfpms:"), cfg.indexOf("\nbrews:"));
  assert.match(nfpms, /formats: \[deb, rpm\]/, "GoReleaser builds both Linux packages");
  assert.match(
    nfpms,
    /^\s+dependencies:\n\s+- rclone$/m,
    "Depends: rclone is the one-command install",
  );
});

test("the Homebrew formula depends on rclone", () => {
  const brews = cfg.slice(cfg.indexOf("\nbrews:"));
  assert.match(brews, /name: drive/, "the formula is named drive");
  assert.match(
    brews,
    /dependencies:\n\s+- name: rclone/,
    "brew install nishfleet/tap/drive also installs rclone",
  );
});

test("no install script is added to the tree", () => {
  assert.doesNotMatch(
    cfg,
    /install\.sh|scripts\//,
    "the one-line install is the package manager, not a script",
  );
});
