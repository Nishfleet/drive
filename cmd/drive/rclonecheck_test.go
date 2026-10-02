package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// writeFakeRclone writes a stand-in for the rclone binary that answers
// `version` with out and exits 0, so CheckRclone's two branches (too old, new
// enough) are exercised against the real code path that runs the binary and
// parses its output, not against a mocked function.
func writeFakeRclone(t *testing.T, out string) string {
	t.Helper()
	dir := t.TempDir()
	path := filepath.Join(dir, "rclone")
	script := "#!/bin/sh\ncat <<'RCLONE_VERSION_END'\n" + out + "RCLONE_VERSION_END\n"
	if err := os.WriteFile(path, []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}
	return path
}

func TestParseRcloneVersion(t *testing.T) {
	cases := []struct {
		name string
		out  string
		want string
		ok   bool
	}{
		{"plain", "rclone v1.75.1\n- os/version: ubuntu 24.04\n", "1.75.1", true},
		{"build suffix", "rclone v1.68.0-002-gabc1234\n", "1.68.0", true},
		{"package suffix", "rclone v1.60.1-DEV\n", "1.60.1", true},
		{"two parts", "rclone v1.68\n", "1.68", true},
		{"other program's banner", "restic 0.16.0\n", "", false},
		{"no version", "rclone version unknown\n", "", false},
		{"too many parts", "rclone v1.2.3.4\n", "", false},
		{"non numeric", "rclone v1.x.0\n", "", false},
		{"empty", "", "", false},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			got, ok := parseRcloneVersion(c.out)
			if got != c.want || ok != c.ok {
				t.Errorf("parseRcloneVersion(%q) = %q, %v; want %q, %v", c.out, got, ok, c.want, c.ok)
			}
		})
	}
}

// TestParseRcloneVersionReadsTheFirstRcloneLine pins that a banner printed
// before rclone's own version line is skipped, and the version line is the one
// read: a wrapper script that echoes something else first must not shift it.
func TestParseRcloneVersionReadsTheFirstRcloneLine(t *testing.T) {
	out := "warning: no config file found\nrclone v1.69.1\n- os/version: debian 13\n"
	got, ok := parseRcloneVersion(out)
	if !ok || got != "1.69.1" {
		t.Fatalf("parseRcloneVersion = %q, %v; want 1.69.1, true", got, ok)
	}
}

func TestCompareVersions(t *testing.T) {
	cases := []struct {
		a, b string
		want int
	}{
		{"1.68.0", "1.68.0", 0},
		{"1.68", "1.68.0", 0},
		{"1.68.0", "1.67.0", 1},
		{"1.60.1", "1.68.0", -1},
		{"1.9.0", "1.10.0", -1},
		{"2.0.0", "1.75.1", 1},
	}
	for _, c := range cases {
		if got := compareVersions(c.a, c.b); got != c.want {
			t.Errorf("compareVersions(%q, %q) = %d; want %d", c.a, c.b, got, c.want)
		}
	}
}

func TestCheckRcloneAcceptsTheFloor(t *testing.T) {
	bin := writeFakeRclone(t, "rclone v"+MinRcloneVersion+"\n- os/version: ubuntu 24.04\n")
	if err := CheckRclone("linux", bin); err != nil {
		t.Fatalf("CheckRclone on the floor version %s: %v", MinRcloneVersion, err)
	}
}

// TestCheckRcloneRefusesUbuntu2404 is the measured case this floor exists for:
// Ubuntu 24.04's archive package is rclone 1.60.1, and the mount's
// --vfs-read-chunk-streams flag does not exist before 1.68.0, so the refusal
// must name the version, the floor, and the download that is newer than the
// archive the package manager has.
func TestCheckRcloneRefusesUbuntu2404(t *testing.T) {
	bin := writeFakeRclone(t, "rclone v1.60.1-DEV\n- os/version: ubuntu 24.04\n")
	err := CheckRclone("linux", bin)
	if err == nil {
		t.Fatal("CheckRclone accepted rclone 1.60.1; it must refuse a version below the floor")
	}
	msg := err.Error()
	for _, want := range []string{"1.60.1", "too old", MinRcloneVersion, "rclone.org/downloads", "--vfs-read-chunk-streams"} {
		if !strings.Contains(msg, want) {
			t.Errorf("refusal must name %q:\n%s", want, msg)
		}
	}
}

func TestCheckRcloneReportsABinaryThatWillNotAnswer(t *testing.T) {
	dir := t.TempDir()
	bin := filepath.Join(dir, "rclone")
	if err := os.WriteFile(bin, []byte("#!/bin/sh\nexit 3\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	err := CheckRclone("linux", bin)
	if err == nil {
		t.Fatal("CheckRclone accepted a binary that exits non-zero")
	}
	if !strings.Contains(err.Error(), "rclone.org/downloads") {
		t.Errorf("a binary that will not run needs the install hint:\n%s", err)
	}
}

func TestRcloneInstallHint(t *testing.T) {
	// A missing rclone gets every package manager, because there is nothing to
	// compare and the package manager's version is the best first answer.
	everywhere := RcloneInstallHint("linux", true)
	for _, want := range []string{"apt install rclone", "dnf install rclone", "pacman -S rclone", "rclone.org/downloads"} {
		if !strings.Contains(everywhere, want) {
			t.Errorf("missing-rclone hint must name %q:\n%s", want, everywhere)
		}
	}
	// A too-old rclone gets the download first: the package manager's rclone is
	// the one that was just refused, so pointing at it alone would loop.
	tooOld := RcloneInstallHint("linux", false)
	if !strings.Contains(tooOld, "https://rclone.org/downloads/") {
		t.Errorf("too-old hint must name the download:\n%s", tooOld)
	}
	if !strings.Contains(tooOld, "Ubuntu 24.04") {
		t.Errorf("too-old hint must name the package that is known to be below the floor:\n%s", tooOld)
	}
	if strings.Index(tooOld, "https://rclone.org/downloads/") > strings.Index(tooOld, "apt install rclone") &&
		strings.Contains(tooOld, "apt install rclone") {
		t.Errorf("too-old hint must put the download before the package that was refused:\n%s", tooOld)
	}
	// macOS always gets brew, whichever branch.
	for _, hint := range []string{RcloneInstallHint("darwin", true), RcloneInstallHint("darwin", false)} {
		if !strings.Contains(hint, "brew install rclone") {
			t.Errorf("darwin hint must name brew:\n%s", hint)
		}
	}
}
