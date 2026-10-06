package main

import (
	"fmt"
	"net/http"
	"net/http/httptest"
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
	want := []string{"drive:", "rclone:", "os:", "mount:", "log:", "api:"}
	for _, w := range want {
		if !strings.Contains(got, w) {
			t.Errorf("doctor block is missing its %q line:\n%s", w, got)
		}
	}
	// Every part prints at least one line, so no answer can come back blank: a
	// part that could not read its answer still prints the named reason on its
	// own line. The floor is the label count itself, which the block can only
	// meet by answering every part. It deliberately does not count the path and
	// next-step lines beside them, whose number depends on the host's own mount
	// state and on whether findmnt is installed at all.
	if lines := countNonBlankLines(got); lines < len(want) {
		t.Fatalf("doctor block has %d non-blank lines, want at least one per label (%d):\n%s", lines, len(want), got)
	}
	// A labelled line carries its answer on the same line: "mount:" with
	// nothing after it is the blank this issue is about.
	for _, label := range want {
		for _, line := range strings.Split(got, "\n") {
			rest, ok := strings.CutPrefix(strings.TrimSpace(line), label)
			if !ok {
				continue
			}
			if strings.TrimSpace(rest) == "" {
				t.Errorf("doctor block's %q line says nothing:\n%s", label, got)
			}
			break
		}
	}
}

// TestDoctorLogLinesAreNamedNotBlank checks the two ways a log is absent: the
// file is not there, or the file is empty. Both must print a line that names
// the path and says what happened, because "the mount's log is missing" is the
// answer when someone reports a mount that never started.
// TestJournaldBannerIsNotALogLine covers the one place a journald answer can
// read as a log line and say nothing: a unit that has never logged prints
// journalctl's own "-- No entries --" banner. The doctor block falls back to
// the mount log on that, because a person pasting "-- No entries --" into a
// ticket has pasted nothing. Every banner shape is here, including the
// "-- Logs begin" line that always heads a real journal.
func TestJournaldBannerIsNotALogLine(t *testing.T) {
	for _, banner := range []string{
		"",
		"   \n\t",
		"-- No entries --",
		"-- Logs begin at Mon 2026-10-07 01:29:17 IST. --\n-- No entries --",
	} {
		if !journaldHasNoEntries(banner) {
			t.Errorf("journaldHasNoEntries(%q) = false, want true so the banner is not printed as a log line", banner)
		}
	}
	for _, line := range []string{
		"Oct 07 01:29:17 host drive-mount[1]: mounted",
		"-- Logs begin at Mon 2026-10-07 01:29:17 IST. --\nOct 07 01:29:17 host drive-mount[1]: mounted",
	} {
		if journaldHasNoEntries(line) {
			t.Errorf("journaldHasNoEntries(%q) = true, want false so a real log line is printed", line)
		}
	}
}

// TestWindowsMountLetterTokenPicksTheDriveLetter is the decision the Windows
// mount line makes, kept pure so it can be tested on a Linux host: the login
// task's command line carries rclone's volume as a two-letter token, and the
// drive letter is that token upper-cased. A longer path token is not a drive
// letter, so a config path like /etc/x must not be read as one.
func TestWindowsMountLetterTokenPicksTheDriveLetter(t *testing.T) {
	command := `\"C:\\rclone.exe\" --config C:\\Users\\nish\\.config\\drive\\rclone.conf mount z: /mnt`
	letter, ok := windowsDriveLetterFromCommand(command)
	if !ok || letter != "Z:" {
		t.Errorf("windowsDriveLetterFromCommand(%q) = %q, %v, want \"Z:\", true", command, letter, ok)
	}
	if _, ok := windowsDriveLetterFromCommand("drive --mount /mnt/point"); ok {
		t.Error("a command with no drive-letter token answered with one")
	}
	if got := windowsVolumeRoot("Z:"); got != `Z:\` {
		t.Errorf("windowsVolumeRoot(\"Z:\") = %q, want %q", got, `Z:\`)
	}
}

// TestDoctorLogLinesAreNamedNotBlank pins the per-OS log location, which
// is the fact the docs page states in its table for all three systems: the
// macOS and Windows reads are a file under the config dir, and Linux's is
// journald's. The docs page and this hint are one decision written twice, so a
// change to either one that the other does not follow is a page that sends a
// person to a log that is not there.
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

	// The docs page's table is the same decision, so it is tied to the code
	// here rather than left to a reader. Linux reads journald, macOS and Windows
	// read the file, and a page that sends one of them to the other place is
	// wrong for the people who follow it.
	for _, goos := range []string{"darwin", "windows"} {
		if got := mountLogHint(goos, "/home/nish"); got != filepath.Join("/home/nish", ".config", "drive", "mount.log") {
			t.Errorf("mountLogHint(%q) = %q, want the mount.log the docs page names", goos, got)
		}
	}
	if got := mountLogHint("linux", "/home/nish"); !strings.Contains(got, "journalctl") || !strings.Contains(got, SystemdUnitName) {
		t.Errorf("mountLogHint(\"linux\") = %q, want the journalctl command the docs page names", got)
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

// TestDoctorAPIUnreachableNamesTheAddress is the branch a host with no network
// takes: the read fails before a status code exists, so the answer is the
// offline one and the address that was tried, side by side. It used to be
// called TestDoctorAPIRefusedToken, which named the branch it does not reach:
// a loopback port that refuses is not a Worker that refused a token.
func TestDoctorAPIUnreachableNamesTheAddress(t *testing.T) {
	var b strings.Builder
	// Port 1 on loopback refuses; the read never gets a status code.
	const tried = "https://127.0.0.1:1"
	printDoctorAPI(&b, t.TempDir(), tried)
	got := doctorAPILine(b.String())
	if !strings.HasSuffix(got, "("+tried+")") {
		t.Errorf("unreachable api = %q, want the address it tried in brackets at the end", got)
	}
	if !strings.Contains(got, "offline") {
		t.Errorf("unreachable api = %q, want the offline answer, not a timeout or a blank", got)
	}
}

// TestDoctorAPIRefusesADeadToken covers the answer a support message cannot
// work without: a device whose stored token the Worker refuses. "The api
// refused the token" is only actionable together with the address that
// refused it and the command that fixes it, and it is the one branch nothing
// reached before, because the loopback-refused test above stops at the
// connection. A stub server over httptest is the only way to get the status
// code, and the repo already runs the CLI against exactly this shape
// (agentkeys_test.go).
// The refusal sentence is a primary support answer, so it is pinned whole:
// a substring check passed while the answer read "refused", and a person has
// to guess what refused.
const refusedTokenAnswer = "refused the device token; run `drive login` on this device again"

func TestDoctorAPIRefusesADeadToken(t *testing.T) {
	// The 401 and the 403 answers are one decision: this device's key is no
	// good, so re-sign in. A table keeps the two status codes the same one
	// assertion instead of two tests that can disagree.
	for _, status := range []int{http.StatusUnauthorized, http.StatusForbidden} {
		t.Run(fmt.Sprint(status), func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				w.WriteHeader(status)
			}))
			t.Cleanup(server.Close)
			home := t.TempDir()
			if err := SaveCredentials(home, Credentials{APIBase: server.URL, DeviceToken: "dtok_dead"}); err != nil {
				t.Fatal(err)
			}
			var b strings.Builder
			printDoctorAPI(&b, home, "")
			if got := doctorAPILine(b.String()); got != refusedTokenAnswer+" ("+server.URL+")" {
				t.Errorf("refused token = %q, want %q (address in brackets)", got, refusedTokenAnswer)
			}
			if strings.Contains(b.String(), "dtok_dead") {
				t.Error("the api line prints the device token, which must never reach a pasted block")
			}
		})
	}
}

// TestDoctorAPIReachableNamesTheAddress is the healthy branch: the Worker
// answered 200 on the same read `drive status` makes. It must say so and name
// the address, because a person deciding whether to write in reads this line
// and "reachable" alone does not tell them which side they are on.
//
// The assertion is the answer itself, not a word inside it: "still reachable"
// also contains "reachable", so a substring check would pass while the answer
// got worse. doctorAPILine hands back the labelled line's answer, which the
// mutation tests proved is what actually holds this branch still.
func TestDoctorAPIReachableNamesTheAddress(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != USAGE_PATH {
			http.NotFound(w, r)
			return
		}
		w.WriteHeader(http.StatusOK)
	}))
	t.Cleanup(server.Close)
	home := t.TempDir()
	if err := SaveCredentials(home, Credentials{APIBase: server.URL, DeviceToken: "dtok_live"}); err != nil {
		t.Fatal(err)
	}
	var b strings.Builder
	printDoctorAPI(&b, home, "")
	if want := "reachable (" + server.URL + ")"; doctorAPILine(b.String()) != want {
		t.Errorf("reachable api = %q, want %q", doctorAPILine(b.String()), want)
	}
}

// doctorAPILine is the answer on the block's api line, without the label or
// its padding: the text a person actually reads. Every api-branch test pins
// this, so an answer that merely contains the right word still fails.
func doctorAPILine(block string) string {
	for _, line := range strings.Split(block, "\n") {
		answer, ok := strings.CutPrefix(strings.TrimSpace(line), "api:")
		if ok {
			return strings.TrimSpace(answer)
		}
	}
	return ""
}

// TestDoctorAnswersAnyOtherStatus covers the Worker-side answers that are
// neither a refusal nor a success: the block names the status code, because
// "the api answered 503" is a different support conversation from "the api
// refused the token" and a person reading the block must be able to tell
// them apart.
func TestDoctorAnswersAnyOtherStatus(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusServiceUnavailable)
	}))
	t.Cleanup(server.Close)
	home := t.TempDir()
	if err := SaveCredentials(home, Credentials{APIBase: server.URL, DeviceToken: "dtok_live"}); err != nil {
		t.Fatal(err)
	}
	var b strings.Builder
	printDoctorAPI(&b, home, "")
	if got, want := doctorAPILine(b.String()), "answered 503 ("+server.URL+")"; got != want {
		t.Errorf("other status = %q, want %q", got, want)
	}
}

// TestDoctorRejectsBadArguments pins the entry contract: the command takes no
// command of its own and --logs counts lines, so it cannot be below zero.
// Both are decisions about what a person can pass, and an untested entry is
// how `drive doctor status` or `drive doctor --logs -1` quietly prints the
// block anyway and wastes the run.
func TestDoctorRejectsBadArguments(t *testing.T) {
	t.Setenv("DRIVE_API_URL", "")
	home := t.TempDir()
	if err := runDoctor([]string{"--home", home, "status"}); err == nil {
		t.Error("drive doctor took a subcommand; it prints the block and takes no command of its own")
	}
	if err := runDoctor([]string{"--home", home, "--logs", "-1"}); err == nil || !strings.Contains(err.Error(), "zero") {
		t.Errorf("--logs -1 = %v, want a refusal that says the count cannot be below zero", err)
	}
	if err := runDoctor([]string{"--home", home, "--no-such-flag"}); err != errFlagParse {
		t.Errorf("an unknown flag = %v, want the flag-parse failure the other commands return", err)
	}
}

// TestDoctorDeclinedAPartIsNotAFailure checks the run stays at exit zero when
// a part cannot read its answer. The command exists to be pasted into a
// ticket: a half-answered block beats none, and a non-zero exit code tells the
// person who pastes it that the command itself broke.
func TestDoctorDeclinedAPartIsNotAFailure(t *testing.T) {
	// Hermetic on purpose: a real device's credentials or a real Worker
	// address in the environment would turn this into a live read, so the
	// home and the api address are both pointed at a scratch directory.
	home := t.TempDir()
	t.Setenv("DRIVE_API_URL", "")
	if err := runDoctor([]string{"--home", home, "--logs", "0"}); err != nil {
		t.Errorf("drive doctor on a host with no log and no api = %v, want exit 0", err)
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
