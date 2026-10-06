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
	if len(q.Names) != 1 || q.Names[0] != "queued.bin" {
		t.Errorf("names = %v, want the dirty file's name so status can print it when the mount is down", q.Names)
	}
}

func TestPendingUploadsIsZeroForAnEmptyQueue(t *testing.T) {
	q, err := PendingUploads(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	if q.Files != 0 || q.Bytes != 0 || len(q.Names) != 0 {
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

func TestPendingUploadsSkipsTruncatedMetaFromACrash(t *testing.T) {
	cache := t.TempDir()
	writeMeta(t, cache, "queued.bin", queuedMeta)
	writeMeta(t, cache, "half-written", `{"Dirty": true, "Size":`)
	q, err := PendingUploads(cache)
	if err != nil {
		t.Fatalf("truncated meta after a crash must not hide the rest of the queue: %v", err)
	}
	if q.Files != 1 || (len(q.Names) > 0 && q.Names[0] != "queued.bin") {
		t.Errorf("got %+v, want only the complete dirty file", q)
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
// the first-run page uses (core/status.js UPLOAD_LABEL). The page is JavaScript
// and cannot import the Go, and the Go cannot import the page, so this
// test is the join between the two copies.
func TestUploadLabelMatchesThePageWords(t *testing.T) {
	page, err := os.ReadFile(filepath.Join("..", "..", "core", "status.js"))
	if err != nil {
		t.Fatal(err)
	}
	html := string(page)
	for _, want := range []string{upToDateLabel, "Uploading 1 file", "Uploading {files} files"} {
		if !strings.Contains(html, want) {
			t.Errorf("core/status.js no longer carries %q; "+
				"the page and the CLI must show the same words for the same queue", want)
		}
	}
}

func TestReadCostLinePrintsTheCapLineFromTheWorker(t *testing.T) {
	const capLine = "Cap $12.00: $1.25 counted this month, $10.75 left."
	var gotPath, gotAuth string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.Path
		gotAuth = r.Header.Get("authorization")
		var u UsageSummary
		u.MeteredUsd, u.BillUsd, u.MaximumUsd = 1.25, 1.25, 10
		u.Cap.CapUsd, u.Cap.CountedUsd, u.Cap.RemainingUsd, u.Cap.State = 12, 1.25, 10.75, "active"
		u.CapLine = capLine
		_ = json.NewEncoder(w).Encode(u)
	}))
	defer srv.Close()

	line := captureStdout(t, func() {
		if reason := readCostLine(srv.URL, "dtok_test"); reason != "" {
			t.Errorf("readCostLine said %q, want the cap line", reason)
		}
	})
	if gotPath != USAGE_PATH {
		t.Errorf("read %s, want %s", gotPath, USAGE_PATH)
	}
	if gotAuth != "Bearer dtok_test" {
		t.Errorf("authorization = %q, want the device token", gotAuth)
	}
	if !strings.Contains(line, capLine) {
		t.Errorf("got %q, want the Worker's capLine printed as-is", line)
	}
}

func TestReadCostLinePrintsTheWorkersReadOnlyCapLine(t *testing.T) {
	const capLine = "Your drive is read-only because it reached its spending cap; nothing was deleted. Raise the cap on the usage page to start writing again.\nCap $12.00 reached: $16.00 counted this month. Uploads waiting in the cache stay on this Mac and go up once the cap is raised."
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var u UsageSummary
		u.CapLine = capLine
		u.Cap.State = "read_only"
		_ = json.NewEncoder(w).Encode(u)
	}))
	defer srv.Close()

	line := captureStdout(t, func() {
		if reason := readCostLine(srv.URL, ""); reason != "" {
			t.Errorf("readCostLine said %q, want the cap line", reason)
		}
	})
	if !strings.Contains(line, "read-only") || !strings.Contains(line, "cap is raised") {
		t.Errorf("got %q, want the Worker's read-only capLine", line)
	}
}

func TestReadCostLinePrintsTheWorkersBalanceLine(t *testing.T) {
	const balanceLine = "Your balance is $0, so uploads are paused. Your files are safe and downloads keep working. Top up to keep adding files."
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var u UsageSummary
		u.CapLine = "Cap $20.00: $0.00 counted this month, $20.00 left."
		u.BalanceLine = balanceLine
		u.Cap.State = "active"
		_ = json.NewEncoder(w).Encode(u)
	}))
	defer srv.Close()

	out := captureStdout(t, func() {
		if reason := readCostLine(srv.URL, ""); reason != "" {
			t.Errorf("readCostLine said %q, want the cap and balance lines", reason)
		}
	})
	if !strings.Contains(out, balanceLine) {
		t.Errorf("got %q, want the Worker's balance line printed as-is", out)
	}
	if !strings.Contains(out, "Top up to keep adding files.") {
		t.Errorf("got %q, want the top-up prompt", out)
	}
}

func TestReadCostLinePrintsSize30AndTodayDraw(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var u UsageSummary
		u.CapLine = "Cap $12.00: $4.00 counted this month, $8.00 left."
		u.Labels.Size30 = "1.0 TB"
		u.Labels.Size30Reached = "2026-09-10"
		u.Labels.Size30DropsOut = "2026-10-10"
		u.Labels.TodayDraw = "$0.50"
		_ = json.NewEncoder(w).Encode(u)
	}))
	defer srv.Close()

	out := captureStdout(t, func() {
		if reason := readCostLine(srv.URL, "dtok_test"); reason != "" {
			t.Errorf("readCostLine said %q, want the size30 lines", reason)
		}
	})
	for _, want := range []string{
		"Biggest size in the last 30 days: 1.0 TB",
		"Reached: 2026-09-10",
		"Drops out: 2026-10-10",
		"Today's draw: $0.50",
	} {
		if !strings.Contains(out, want) {
			t.Errorf("got %q, want %q", out, want)
		}
	}
}

func TestReadCostLineNamesTheFailureInsteadOfGuessing(t *testing.T) {
	cases := []struct {
		name string
		base string
		want string
	}{
		{"unconfigured", "", "No drive api is configured"},
		{"bad url", "ftp://drive.example", "must be http or https"},
		{"no host", "https://", "no host"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			line := captureStdout(t, func() {
				reason := readCostLine(tc.base, "")
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
	reason := readCostLine(srv.URL, "")
	if want := fail("api-down").Error(); reason != want {
		t.Errorf("reason %q, want %q", reason, want)
	}
	if strings.Contains(reason, "500") || strings.Contains(reason, "nope") {
		t.Errorf("reason %q carries raw error text; it must not", reason)
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

func TestQueueWhySaysWhatIsWaitingAndWhy(t *testing.T) {
	waiting := Pending{Files: 1, Bytes: 1024, Names: []string{"cut-off.bin"}}
	got := queueWhy(false, false, false, waiting)
	if !strings.Contains(got, "cut-off.bin") {
		t.Errorf("unmounted = %q, want the waiting file named", got)
	}
	if !strings.Contains(got, waitingUnmountedWhy) || !strings.Contains(got, waitingUnmountedNext) {
		t.Errorf("unmounted = %q, want the not-mounted reason", got)
	}
	if got := queueWhy(true, false, false, waiting); got != waitingToUploadWhy {
		t.Errorf("mounted = %q, want %q", got, waitingToUploadWhy)
	}
	if got := queueWhy(true, true, false, Pending{}); !strings.Contains(got, diskCacheFullWhat) || !strings.Contains(got, diskCacheFullNext) {
		t.Errorf("full cache = %q, want the disk-cache-full words", got)
	}
	if got := queueWhy(true, false, true, waiting); got != "" {
		t.Errorf("paused = %q, want empty so pause (issue #100) is not duplicated", got)
	}
	if got := queueWhy(true, false, false, Pending{}); got != "" {
		t.Errorf("empty = %q, want nothing extra", got)
	}
}

func TestQueueWhyWordsMatchTheSources(t *testing.T) {
	page, err := os.ReadFile(filepath.Join("..", "..", "core", "status.js"))
	if err != nil {
		t.Fatal(err)
	}
	html := string(page)
	for _, want := range []string{waitingToUploadWhy, waitingUnmountedWhy, waitingUnmountedNext} {
		if !strings.Contains(html, want) {
			t.Errorf("core/status.js no longer carries %q", want)
		}
	}
	messages, err := os.ReadFile(filepath.Join("..", "..", "core", "messages.js"))
	if err != nil {
		t.Fatal(err)
	}
	text := string(messages)
	if !strings.Contains(text, diskCacheFullWhat) || !strings.Contains(text, diskCacheFullNext) {
		t.Errorf("core/messages.js no longer carries the disk-cache-full words; the CLI must print the table")
	}
}

func TestCacheIsFullReadsRcloneOutOfSpace(t *testing.T) {
	home := t.TempDir()
	c := fakeRclone(t, func(w http.ResponseWriter, r *http.Request) {
		if strings.Contains(r.URL.Path, "vfs/stats") {
			_, _ = w.Write([]byte(`{"diskCache":{"outOfSpace":true}}`))
			return
		}
		_, _ = w.Write([]byte(`{}`))
	})
	t.Setenv("DRIVE_RCLONE", c.binary)
	t.Setenv("DRIVE_RC_ADDR", c.addr)
	if !cacheIsFull(home, true) {
		t.Fatal("cacheIsFull = false, want true when rclone vfs/stats says outOfSpace")
	}
}

// TestCacheStateReadsTheCapAndUseFromVFSStats is issue #543's watcher: the
// status line is driven by rclone's own vfs/stats numbers, so a paused mount
// with more unsent saves than the cache cap names the real cause instead of
// telling the person to free disk space.
func TestCacheStateReadsTheCapAndUseFromVFSStats(t *testing.T) {
	home := t.TempDir()
	c := fakeRclone(t, func(w http.ResponseWriter, r *http.Request) {
		if strings.Contains(r.URL.Path, "vfs/stats") {
			_, _ = w.Write([]byte(`{"opt":{"CacheMaxSize":1073741824},"diskCache":{"bytesUsed":1610612736}}`))
			return
		}
		_, _ = w.Write([]byte(`{}`))
	})
	t.Setenv("DRIVE_RCLONE", c.binary)
	t.Setenv("DRIVE_RC_ADDR", c.addr)
	capBytes, usedBytes, ok := cacheState(home, true)
	if !ok {
		t.Fatal("cacheState did not read vfs/stats")
	}
	if capBytes != 1<<30 || usedBytes != 3<<29 {
		t.Fatalf("cacheState = (%d, %d), want the vfs/stats cap and use", capBytes, usedBytes)
	}
	line := cacheCapWhy(capBytes, usedBytes, 2<<30, true, true)
	if !strings.Contains(line, "past its 1.0 GiB limit") || !strings.Contains(line, "paused") {
		t.Errorf("cap line = %q, want the exceeded cap and the paused cause", line)
	}
}

// TestFormatRCProgressRendersAFailingUpload is issue #543's third line:
// rclone reports how many times it has tried and failed to send a save and
// how long until it tries again; more than three tries is a failing save, not
// a waiting one. The numbers are rclone's own vfs/queue fields.
func TestFormatRCProgressRendersAFailingUpload(t *testing.T) {
	got := formatRCProgress(
		[]QueueItem{{Name: "stuck.bin", Size: 10 * 1024 * 1024, Tries: 14, Delay: 300}},
		Stats{},
	)
	if !strings.Contains(got, "failed 14 times, retrying in 5 minutes") {
		t.Errorf("failing line = %q, want the tries and the delay rclone reports", got)
	}
}

// TestFormatRCProgressKeepsAWorkingUploadAtWaiting: an item with no failed
// tries is still just waiting, so the failing words do not leak onto a save
// that is moving.
func TestFormatRCProgressKeepsAWorkingUploadAtWaiting(t *testing.T) {
	got := formatRCProgress([]QueueItem{{Name: "ok.bin", Size: 1024}}, Stats{})
	if strings.Contains(got, "failed") {
		t.Errorf("waiting line = %q, must not read as failing", got)
	}
	if !strings.Contains(got, "waiting") {
		t.Errorf("waiting line = %q, want waiting", got)
	}
}

// TestUploadFailingIsANamedFailure is the summary status prints above the
// per-file block: a save past the threshold is a named failure with a next
// step that points at the storage error in the mount's log, not a bare
// "waiting".
func TestUploadFailingIsANamedFailure(t *testing.T) {
	line := failf("upload-failing", "14", "the drive log").Error()
	if !strings.Contains(line, "failed to upload 14 times") {
		t.Errorf("upload-failing = %q, want the try count", line)
	}
	if !strings.Contains(line, "Next:") || !strings.Contains(line, "the drive log") {
		t.Errorf("upload-failing = %q, want a next step naming the log", line)
	}
}

// TestMaxUploadTriesReadsTheQueue pins the threshold's input: the summary
// fires on the highest try count in the queue, so one dead file is enough.
func TestMaxUploadTriesReadsTheQueue(t *testing.T) {
	if got := maxUploadTries([]QueueItem{{Tries: 1}, {Tries: 14}, {Tries: 2}}); got != 14 {
		t.Errorf("maxUploadTries = %d, want 14", got)
	}
	if got := maxUploadTries(nil); got != 0 {
		t.Errorf("maxUploadTries(nil) = %d, want 0", got)
	}
}

// TestCacheCapWhyNamesTheCauseWhenDirtySavesExceedTheCap is issue #543's
// headline: a paused mount with 2 GiB of saves is over the cache cap because
// the saves are unsent, not because the disk needs freeing. The line must say
// the cap is exceeded and name the real cause.
func TestCacheCapWhyNamesTheCauseWhenDirtySavesExceedTheCap(t *testing.T) {
	const (
		giB = 1 << 30
		cap = 1 * giB
	)
	dirty := int64(2 * giB)
	got := cacheCapWhy(cap, 3*giB/2, dirty, true, true)
	if got == "" {
		t.Fatal("cacheCapWhy = empty, want the cap-exceeded line")
	}
	if !strings.Contains(got, "past its 1.0 GiB limit") {
		t.Errorf("cacheCapWhy = %q, want the cap named as exceeded", got)
	}
	if !strings.Contains(got, "2.0 GiB of saves") || !strings.Contains(got, "paused") {
		t.Errorf("cacheCapWhy = %q, want the waiting bytes and the paused cause", got)
	}
	if !strings.Contains(got, "Next:") {
		t.Errorf("cacheCapWhy = %q, want a next step", got)
	}
	// A paused cause must not be claimed when the drive is running.
	if got := cacheCapWhy(cap, 3*giB/2, dirty, false, true); !strings.Contains(got, "uploads are behind") {
		t.Errorf("running cause = %q, want uploads behind, not paused", got)
	}
	// Inside the cap the line is silent, so a healthy drive prints nothing.
	if got := cacheCapWhy(20*giB, 1*giB, 2*giB, true, true); got != "" {
		t.Errorf("inside the cap = %q, want empty", got)
	}
	// No limit means no claim.
	if got := cacheCapWhy(0, 5*giB, 5*giB, true, true); got != "" {
		t.Errorf("no cap = %q, want empty", got)
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
