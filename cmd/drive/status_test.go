package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// writeVFSMeta writes one rclone VFS cache metadata file, the way rclone
// writes it. The two bodies are the real ones, copied from a live mount
// against a `rclone serve s3` stand-in on this host 2026-09-30
// (rclone v1.75.1): the queued file has no fingerprint and Dirty true, the
// finished one carries the remote's fingerprint and Dirty false.
const queuedMeta = `{
	"ModTime": "2026-09-30T16:57:22.529231724+05:30",
	"ATime": "2026-09-30T16:57:22.529751179+05:30",
	"Size": 8388608,
	"Rs": [
		{
			"Pos": 0,
			"Size": 8388608
		}
	],
	"Fingerprint": "",
	"Dirty": true
}`

const uploadedMeta = `{
	"ModTime": "2026-09-30T16:57:22.529231724+05:30",
	"ATime": "2026-09-30T16:57:22.529751179+05:30",
	"Size": 2,
	"Rs": [
		{
			"Pos": 0,
			"Size": 2
		}
	],
	"Fingerprint": "2,2026-09-30 11:27:22.529231724 +0000 UTC,401b30e3b8b5d629635a5c613cdb7919",
	"Dirty": false
}`

func writeMeta(t *testing.T, cacheDir, name, body string) {
	t.Helper()
	path := filepath.Join(cacheDir, "vfsMeta", "drive", "bucket", "u", "me", name)
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(body), 0o644); err != nil {
		t.Fatal(err)
	}
}

func TestPendingUploadsCountsOnlyDirtyMetaFiles(t *testing.T) {
	cache := t.TempDir()
	writeMeta(t, cache, "queued.bin", queuedMeta)
	writeMeta(t, cache, "done.txt", uploadedMeta)

	q, err := PendingUploads(cache)
	if err != nil {
		t.Fatal(err)
	}
	if q.Files != 1 {
		t.Errorf("files = %d, want 1 (only the Dirty meta file counts)", q.Files)
	}
	if q.Bytes != 8388608 {
		t.Errorf("bytes = %d, want 8388608 (the queued file's Size)", q.Bytes)
	}
}

func TestPendingUploadsIsZeroForAnEmptyQueue(t *testing.T) {
	q, err := PendingUploads(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	if q != (Pending{}) {
		t.Errorf("got %+v, want the zero queue for a cache that was never used", q)
	}
}

func TestPendingUploadsFailsOnUnreadableMeta(t *testing.T) {
	cache := t.TempDir()
	writeMeta(t, cache, "broken", "not json")
	// A queue that cannot be read must be an error, never a silent "up to
	// date": the difference is a person's belief that their work is safe.
	if _, err := PendingUploads(cache); err == nil {
		t.Fatal("got no error for unparseable vfs metadata, want one")
	}
}

func TestUploadLabel(t *testing.T) {
	cases := []struct {
		name string
		q    Pending
		want string
	}{
		{"empty", Pending{}, "Up to date"},
		{"one", Pending{Files: 1}, "Uploading 1 file"},
		{"many", Pending{Files: 7}, "Uploading 7 files"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := UploadLabel(tc.q); got != tc.want {
				t.Errorf("UploadLabel(%+v) = %q, want %q", tc.q, got, tc.want)
			}
		})
	}
}

// TestUploadLabelMatchesThePageWords pins the CLI's queue words to the ones
// the first-run page uses (src/status.js UPLOAD_LABEL). The page is JavaScript
// and cannot import the Go, and the Go cannot import the page, so this
// test is the join between the two copies.
func TestUploadLabelMatchesThePageWords(t *testing.T) {
	page, err := os.ReadFile(filepath.Join("..", "..", "src", "status.js"))
	if err != nil {
		t.Fatal(err)
	}
	html := string(page)
	for _, want := range []string{upToDateLabel, "Uploading 1 file", "Uploading {files} files"} {
		if !strings.Contains(html, want) {
			t.Errorf("src/status.js no longer carries %q; "+
				"the page and the CLI must show the same words for the same queue", want)
		}
	}
}

func TestReadCostLinePrintsTheMonthAndCap(t *testing.T) {
	var gotPath string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.Path
		// The empty-month shape src/billing.js `usageSummary()` returns
		// before the meter and the account store land (issues #6 and #2).
		var u UsageSummary
		u.MeteredUsd, u.BillUsd, u.CeilingUsd = 1.25, 1.25, 12
		u.Cap.CapUsd, u.Cap.CountedUsd, u.Cap.RemainingUsd, u.Cap.State = 12, 1.25, 10.75, "active"
		_ = json.NewEncoder(w).Encode(u)
	}))
	defer srv.Close()

	line := captureStdout(t, func() {
		if reason := readCostLine(srv.URL); reason != "" {
			t.Errorf("readCostLine said %q, want the numbers", reason)
		}
	})
	if gotPath != USAGE_PATH {
		t.Errorf("read %s, want %s", gotPath, USAGE_PATH)
	}
	if !strings.Contains(line, "$1.25 of $12.00 cap") {
		t.Errorf("got %q, want the metered cost and the cap on the line", line)
	}
}

func TestReadCostLineSaysReadOnlyAndWhatToDo(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(`{"meteredUsd":16,"billUsd":16,"ceilingUsd":16,"cap":{"capUsd":12,"countedUsd":16,"remainingUsd":0,"state":"read_only"}}`))
	}))
	defer srv.Close()

	line := captureStdout(t, func() {
		if reason := readCostLine(srv.URL); reason != "" {
			t.Errorf("readCostLine said %q, want the numbers", reason)
		}
	})
	// A read-only drive is the one cost line that has to carry an action:
	// every error says what to do next (issue #35).
	if !strings.Contains(line, "read-only") || !strings.Contains(line, "cap is raised") {
		t.Errorf("got %q, want the read-only state and what to do about it", line)
	}
}

func TestReadCostLineNamesTheFailureInsteadOfGuessing(t *testing.T) {
	cases := []struct {
		name string
		base string
		want string
	}{
		{"unconfigured", "", "no api Worker configured"},
		{"bad url", "ftp://drive.example", "must be http or https"},
		{"no host", "https://", "no host"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			line := captureStdout(t, func() {
				reason := readCostLine(tc.base)
				if !strings.Contains(reason, tc.want) {
					t.Errorf("reason %q does not name %q", reason, tc.want)
				}
			})
			// An unknown number is never printed as a number: the line names
			// the failure instead.
			if strings.Contains(line, "$0.00") {
				t.Errorf("got %q, want no invented cost", line)
			}
		})
	}
}

func TestReadCostLineNamesAnUnreachableService(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Error(w, "nope", http.StatusInternalServerError)
	}))
	defer srv.Close()
	reason := readCostLine(srv.URL)
	if !strings.Contains(reason, "500") {
		t.Errorf("reason %q, want the failing status named", reason)
	}
}

func TestParseAPIBaseTrimsTheTrailingSlash(t *testing.T) {
	got, err := parseAPIBase("https://drive.example/")
	if err != nil {
		t.Fatal(err)
	}
	if got != "https://drive.example" {
		t.Errorf("got %q, want the slash trimmed so %s joins cleanly", got, USAGE_PATH)
	}
}

func TestParseAPIBaseRejectsAValueThatWouldBreakTheLine(t *testing.T) {
	if _, err := parseAPIBase("https://drive.example\nGET /elsewhere"); err == nil {
		t.Fatal("got no error for a newline in the api Worker URL, want one")
	}
}

// captureStdout runs fn with os.Stdout redirected to a pipe and returns what
// it printed. The status and logout lines are the command's output, so the
// tests assert on the text the person reads, not on a struct nobody prints.
func captureStdout(t *testing.T, fn func()) string {
	t.Helper()
	r, w, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	saved := os.Stdout
	os.Stdout = w
	done := make(chan string, 1)
	go func() {
		var b strings.Builder
		buf := make([]byte, 4096)
		for {
			n, err := r.Read(buf)
			b.Write(buf[:n])
			if err != nil {
				break
			}
		}
		done <- b.String()
	}()
	fn()
	os.Stdout = saved
	if err := w.Close(); err != nil {
		t.Fatal(err)
	}
	return <-done
}
