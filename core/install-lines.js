// The one pasted install line per system (drive#509). The values here are the
// commands .goreleaser.yaml actually publishes: Homebrew's tap path, and the
// .deb / .rpm files nfpm writes. test/packaging.test.mjs derives the same
// three lines from that YAML and fails when this file, the CLI help, or the
// docs drift. The get-started page and the docs read this module, so they
// cannot keep a second copy that still says `brew install drive`.

export const INSTALL_LINES = Object.freeze([
  Object.freeze({ os: "macOS", line: "brew install nish3451/tap/drive" }),
  Object.freeze({ os: "Linux, Debian or Ubuntu", line: "sudo apt install ./drive_*.deb" }),
  Object.freeze({ os: "Linux, Fedora or RHEL", line: "sudo dnf install ./drive_*.rpm" }),
]);
