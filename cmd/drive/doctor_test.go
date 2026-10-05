package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// The `drive doctor` gates (drive issue #562). The command is the one block a
// person pastes into a support message, so its tests pin the shape rather than
// a fixture: every part of it must be present under a label, whatever the host
// has, and the parts that read from disk must degrade to a named line instead
// of a blank one. A blank line in a support block is the failure this issue is
// about: a person is told "send us your doctor output" and the answer they get
// is nothing.

// TestDoctorBlockHasEveryLabel runs the real command's print path into a buffer
// and fails on a missing label. The point of the issue is one block, so the
// block is only useful if all four answers are in it on the same run.
func TestDoctorBlockHasEveryLabel(t *testing.T) {
	home := t.TempDir()
	var b strings.Builder
	printDoctorVersions(&b, "")
	printDoctorMount(&b, "plan9", home) // an OS no mount check can answer
	printDoctorLogs(&b, "plan9", home, 20)
	printDoctorAPI(&b, home, "")
	got := b.String()
	if lines := countNonBlankLines(got); lines < 7 {
		t.Fatalf("doctor block has %d lines, want at least the four answers and two of their paths:\n%s", lines, got)
	}
	for _, want := range []string{"drive:", "rclone:", "os:", "mount:", "log:", "api:"} {
		if !strings.Contains(got, want) {
			t.Errorf("doctor block is missing its %q line:\n%s", want, got)
		}
	}
}

// TestDoctorLogLinesAreNamedNotBlank checks the two ways a log is absent: the
// file is not there, or the file is empty. Both must print a line that names
// the path and says what happened, because "the mount's log is missing" is the
// answer when someone reports a mount that never started.
func TestDoctorLogLinesAreNamedNotBlank(t *testing.T) {
	var b strings.Builder
	printDoctorLogFile(&b, filepath.Join(t.TempDir(), "no", "such", "mount.log"), 20)
	if got := b.String(); !strings.Contains(got, "cannot read") {
		t.Errorf("missing log = %q, want the named reason", got)
	}

	dir := t.TempDir()
	path := filepath.Join(dir, "mount.log")
	if err := os.WriteFile(path, nil, 0o600); err != nil {
		t.Fatal(err)
	}
	b.Reset()
	printDoctorLogFile(&b, path, 20)
	if got := b.String(); !strings.Contains(got, "is empty") {
		t.Errorf("empty log = %q, want the named reason", got)
	}
}

// TestDoctorLogTailKeepsLastLines writes more lines than the cap and checks the
// block carries the newest ones. A support block with the first lines of a
// long-lived mount's log is the mount's install day, not the failure.
func TestDoctorLogTailKeepsLastLines(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "mount.log")
	if err := os.WriteFile(path, []byte("one\ntwo\nthree\nfour\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	tail, err := tailFile(path, 2)
	if err != nil {
		t.Fatal(err)
	}
	if len(tail) != 2 || tail[0] != "three" || tail[1] != "four" {
		t.Errorf("tailFile(path, 2) = %q, want [three four]", tail)
	}
}

// TestDoctorLogsZeroSkips checks --logs 0 prints the skip line rather than a
// blank one, so the block still says which question it did not answer.
func TestDoctorLogsZeroSkips(t *testing.T) {
	var b strings.Builder
	printDoctorLogs(&b, "plan9", t.TempDir(), 0)
	if got := b.String(); !strings.Contains(got, "skipped") {
		t.Errorf("--logs 0 = %q, want the skip line", got)
	}
}

// TestDoctorAPINotSignedIn checks the branch a support message hits most: a
// device with no credentials. The answer is what to run, not a timeout or an
// address the person never saw.
func TestDoctorAPINotSignedIn(t *testing.T) {
	var b strings.Builder
	printDoctorAPI(&b, t.TempDir(), "")
	if got := b.String(); !strings.Contains(got, "not signed in") || !strings.Contains(got, "drive login") {
		t.Errorf("no credentials = %q, want the reason and the command", got)
	}
}

// TestDoctorAPIRefusedToken checks the 401 branch: the address is printed
// beside the answer, because "the api refused the token" is only actionable
// together with which address refused it.
func TestDoctorAPIRefusedToken(t *testing.T) {
	var b strings.Builder
	printDoctorAPI(&b, t.TempDir(), "https://127.0.0.1:1")
	got := b.String()
	if !strings.Contains(got, "127.0.0.1:1") {
		t.Errorf("unreachable api = %q, want the address it tried", got)
	}
}

// countNonBlankLines counts the lines of a block that say something. A blank
// line is the failure mode this issue is about, so the count is of answers.
func countNonBlankLines(s string) int {
	n := 0
	for _, line := range strings.Split(s, "\n") {
		if strings.TrimSpace(line) != "" {
			n++
		}
	}
	return n
}
