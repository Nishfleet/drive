package main

import (
	"bytes"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// firstRunBeforeLines is how many non-empty lines origin/main printed for
// `drive init` with no agent tools and a minter already attached: the drive
// folder line, five "not installed" lines, and "no agent tools found".
const firstRunBeforeLines = 7

// firstRunAfterLines is the same run after the delight pass: "no agent tools
// found" and one closing line that says to mount. Measured by
// TestFirstRunTranscript.
const firstRunAfterLines = 2

type stubMinter struct{}

func (stubMinter) MintKey(string, string) (MintedKey, error) { return MintedKey{}, nil }
func (stubMinter) RevokeKey(string) error                    { return nil }

func printedFailure(err error) string {
	var b strings.Builder
	printFailure(&b, err)
	return b.String()
}

func nonEmptyLines(s string) []string {
	var out []string
	for _, line := range strings.Split(s, "\n") {
		if strings.TrimSpace(line) != "" {
			out = append(out, line)
		}
	}
	return out
}

func TestFailureTableIsComplete(t *testing.T) {
	if len(messageTable) == 0 {
		t.Fatal("messageTable is empty")
	}
	for kind, entry := range messageTable {
		if strings.TrimSpace(entry[0]) == "" {
			t.Errorf("%s: what is empty", kind)
		}
		if strings.TrimSpace(entry[1]) == "" {
			t.Errorf("%s: next is empty", kind)
		}
		if strings.Contains(entry[0], "\n") || strings.Contains(entry[1], "\n") {
			t.Errorf("%s: what or next is more than one line", kind)
		}
		got := printedFailure(fail(kind))
		if !strings.Contains(got, "next:") {
			t.Errorf("%s: printFailure output has no next step:\n%s", kind, got)
		}
		if strings.Contains(got, "this failure has no message table entry") {
			t.Errorf("%s: treated as unclassified:\n%s", kind, got)
		}
	}
}

func TestSharedKindsMatchThePageTable(t *testing.T) {
	page, err := os.ReadFile(filepath.Join("..", "..", "src", "messages.js"))
	if err != nil {
		t.Fatal(err)
	}
	text := string(page)
	for _, kind := range []string{"offline", "key-revoked", "storage-down", "cap-reached", "unexpected", "disk-cache-full"} {
		entry, ok := messageTable[kind]
		if !ok {
			t.Errorf("CLI table missing shared kind %s", kind)
			continue
		}
		if !strings.Contains(text, entry[0]) {
			t.Errorf("src/messages.js no longer carries the CLI what for %s: %q", kind, entry[0])
		}
	}
}

func TestPrintFailureNeverShowsABareError(t *testing.T) {
	cases := []struct {
		name string
		err  error
	}{
		{"rclone filesystem", fmt.Errorf(`Failed to create file system for "drive:bucket": didn't find section in config file`)},
		{"s3 access denied", fmt.Errorf("AccessDenied: The AWS Access Key Id you provided does not exist in our records")},
		{"rclone exit", fmt.Errorf("rclone mount: exit status 1")},
		{"storage http", fmt.Errorf("Get \"https://s3.example/bucket\": connection refused")},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := printedFailure(tc.err)
			if !strings.Contains(strings.ToLower(got), "next:") {
				t.Errorf("bare error printed with no next step:\n%s", got)
			}
			if !strings.Contains(got, fail("unexpected").What) {
				t.Errorf("bare error did not use the unexpected table entry:\n%s", got)
			}
			if strings.Contains(got, "AccessDenied") || strings.Contains(got, "didn't find section") {
				t.Errorf("raw storage or rclone text reached the person:\n%s", got)
			}
		})
	}
}

func TestErrorPathsHaveANextStep(t *testing.T) {
	t.Setenv("DRIVE_S3_ACCESS_KEY_ID", "")
	t.Setenv("DRIVE_S3_SECRET_ACCESS_KEY", "")
	home := t.TempDir()
	writeMeta(t, DefaultCacheDir(home), "queued.bin", queuedMeta)

	paths := []struct {
		name string
		err  error
	}{
		{"missing-config", func() error { _, err := LoadStorageConfig("", "", "", "", "", ""); return err }()},
		{"no-rclone", func() error { _, err := ResolveRclone("rclone-that-is-not-installed"); return err }()},
		{"unknown-tool", func() error { _, err := toolByName("not-a-tool"); return err }()},
		{"uploads-stuck", Logout("linux", home, false, nil, noAPIKeyStore{})},
		{"no-api", fail("no-api")},
		{"mount-hung", failDetail("mount-hung", nil, "30s", "journalctl --user -u drive-mount.service")},
		{"api-down", fail("api-down")},
	}
	for _, tc := range paths {
		t.Run(tc.name, func(t *testing.T) {
			if tc.err == nil {
				t.Fatal("error path returned nil")
			}
			got := printedFailure(tc.err)
			if !strings.Contains(strings.ToLower(got), "next:") {
				t.Errorf("error path printed with no next step:\n%s", got)
			}
		})
	}
}

func TestFirstRunTranscript(t *testing.T) {
	runner := &recordingRunner{}
	env := Env{
		Home:     t.TempDir(),
		Runner:   runner,
		Minter:   stubMinter{},
		LookPath: func(string) (string, error) { return "", fmt.Errorf("not on PATH") },
	}.withDefaults()
	out := captureStdout(t, func() {
		if err := initAgents(env); err != nil {
			t.Fatal(err)
		}
	})
	lines := nonEmptyLines(out)
	if len(lines) != firstRunAfterLines {
		t.Errorf("first-run lines = %d, want %d after the delight pass (before was %d):\n%s",
			len(lines), firstRunAfterLines, firstRunBeforeLines, out)
	}
	if strings.Contains(out, "not installed") {
		t.Errorf("first run still lists tools that are not installed:\n%s", out)
	}
	if strings.Contains(out, "drive folder:") {
		t.Errorf("first run still prints the debug drive-folder line:\n%s", out)
	}
	last := lines[len(lines)-1]
	if !strings.Contains(last, "drive mount") && !strings.Contains(last, "Your drive is at") {
		t.Errorf("first run does not end on one clear next line: %q", last)
	}
}

func TestWaitMountedShowsProgress(t *testing.T) {
	var buf bytes.Buffer
	err := waitMountedFor("linux", t.TempDir(), 50*time.Millisecond, 10*time.Millisecond, &buf)
	if err == nil {
		t.Fatal("waitMountedFor returned nil on a folder that is not mounted")
	}
	got := buf.String()
	if !strings.Contains(got, "Starting the mount") {
		t.Errorf("long wait was silent: %q", got)
	}
	var f *failure
	if !errors.As(err, &f) || f.Kind != "mount-hung" {
		t.Errorf("timeout = %v, want the mount-hung table entry", err)
	}
	if !strings.Contains(printedFailure(err), "next:") {
		t.Errorf("timeout has no next step: %v", err)
	}
}

func TestStatusAnswersInUnderTenLines(t *testing.T) {
	home := t.TempDir()
	out := captureStdout(t, func() {
		if err := runStatus([]string{"--home", home}); err != nil {
			t.Fatal(err)
		}
	})
	lines := nonEmptyLines(out)
	if len(lines) > 10 {
		t.Errorf("drive status printed %d lines, want under 10:\n%s", len(lines), out)
	}
	joined := strings.Join(lines, "\n")
	if !strings.Contains(joined, "drive: not mounted") {
		t.Errorf("status does not answer whether it is working:\n%s", out)
	}
	if !strings.Contains(joined, "uploads:") {
		t.Errorf("status does not answer what is waiting:\n%s", out)
	}
	if !strings.Contains(joined, "this month:") && !strings.Contains(joined, "Cap ") {
		t.Errorf("status does not answer how much is being spent:\n%s", out)
	}
	if strings.Contains(joined, "rclone config:") || strings.Contains(joined, "login item:") {
		t.Errorf("status still prints debug paths:\n%s", out)
	}
}

func TestRenderMountState(t *testing.T) {
	var b strings.Builder
	renderMountState(&b, false, nil, "/tmp/Drive", "linux", "/tmp")
	got := b.String()
	if !strings.Contains(got, "drive: not mounted") || !strings.Contains(got, "drive mount") {
		t.Errorf("unmounted = %q, want the mount command", got)
	}
	b.Reset()
	renderMountState(&b, true, nil, "/tmp/Drive", "linux", "/tmp")
	if got := b.String(); got != "drive: mounted at /tmp/Drive\n" {
		t.Errorf("mounted = %q", got)
	}
	b.Reset()
	renderMountState(&b, true, fmt.Errorf("timed out after 2s"), "/tmp/Drive", "linux", "/tmp")
	got = b.String()
	if !strings.Contains(got, "not responding") || !strings.Contains(got, "next:") {
		t.Errorf("silent mount = %q, want what happened and the next step", got)
	}
}

func TestFailDetailUnknownKindDoesNotPanic(t *testing.T) {
	err := failDetail("not-a-kind", fmt.Errorf("underlying"))
	var f *failure
	if !errors.As(err, &f) {
		t.Fatalf("got %T, want a table failure", err)
	}
	if f.Kind != "unexpected" {
		t.Errorf("kind = %q, want unexpected so the person still gets a next step", f.Kind)
	}
	got := printedFailure(err)
	if !strings.Contains(got, "next:") {
		t.Errorf("unknown kind printed with no next step:\n%s", got)
	}
}

func TestLimitStatusLines(t *testing.T) {
	block := "a\nb\nc\nd\n"
	got := limitStatusLines(block, 3)
	if strings.Count(strings.TrimSpace(got), "\n")+1 != 4 {
		t.Errorf("limitStatusLines = %q, want 3 kept lines plus and-more", got)
	}
	if !strings.Contains(got, "and 1 more") {
		t.Errorf("limitStatusLines = %q, want the leftover count", got)
	}
}
