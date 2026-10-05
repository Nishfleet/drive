package main

// drive#560's tests: the CLI names itself with a versioned User-Agent on
// every api call, a 426 from the api Worker prints the message table's update
// sentence, and the once-a-day update notice asks whether a newer drive
// exists at most every 24 hours and prints at most once in that window. The
// notice tests run the real noticeUpdateOnceADay against a temp state file,
// a hand-stepped clock and a local update read, so the caching and the
// once-a-day rule are proven on the code that ships.

import (
	"bytes"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"testing"
	"time"
)

func TestUserAgentNamesTheVersionPlatformAndArch(t *testing.T) {
	want := fmt.Sprintf("drive/%s (%s/%s)", versionText(), runtime.GOOS, runtime.GOARCH)
	if got := userAgent(); got != want {
		t.Errorf("userAgent() = %q, want %q", got, want)
	}
}

// TestTheCLINamesItselfOnEveryAPICall sends the two request builders the CLI
// talks to the api Worker with through a real httptest server, and requires
// both requests to carry the drive/<version> (<os>/<arch>) User-Agent the
// server's version gate reads (drive#560). A request without it would be
// judged by nothing and answered as though the version were fine.
func TestTheCLINamesItselfOnEveryAPICall(t *testing.T) {
	seen := make(chan string, 2)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		seen <- r.Header.Get("user-agent")
		w.Header().Set("content-type", "application/json")
		_, _ = w.Write([]byte(`{}`))
	}))
	defer server.Close()
	client, err := NewAPIClient(server.URL, "device-token")
	if err != nil {
		t.Fatal(err)
	}
	var out map[string]any
	if err := client.post("/v1/device/code", map[string]string{"name": "test"}, &out); err != nil {
		t.Fatalf("post: %v", err)
	}
	if got := <-seen; got != userAgent() {
		t.Errorf("do() sent User-Agent %q, want %q", got, userAgent())
	}
	resp, err := client.doRaw(http.MethodDelete, "/v1/keys/k1", nil)
	if err != nil {
		t.Fatalf("doRaw: %v", err)
	}
	_ = resp.Body.Close()
	if got := <-seen; got != userAgent() {
		t.Errorf("doRaw() sent User-Agent %q, want %q", got, userAgent())
	}
}

// TestAFourTwoSixPrintsTheUpdateSentence is the drive#560 end to end half on
// the CLI side: the server refuses this client's versioned request with 426
// and its own sentence, and the failure the person sees is the message
// table's cli-too-old entry, not api-refused's.
func TestAFourTwoSixPrintsTheUpdateSentence(t *testing.T) {
	entry := messageTable["cli-too-old"]
	body, err := json.Marshal(map[string]string{"error": entry[0]})
	if err != nil {
		t.Fatal(err)
	}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// The request that gets refused is one that named its own version,
		// so the gate had something to judge.
		if got := r.Header.Get("user-agent"); !strings.HasPrefix(got, "drive/"+versionText()+" ") {
			t.Errorf("the refused request sent User-Agent %q, want a drive/<version> one", got)
		}
		w.Header().Set("content-type", "application/json")
		w.WriteHeader(http.StatusUpgradeRequired)
		_, _ = w.Write(body)
	}))
	defer server.Close()
	client, err := NewAPIClient(server.URL, "")
	if err != nil {
		t.Fatal(err)
	}
	var out map[string]any
	err = client.post("/v1/device/code", map[string]string{"name": "test"}, &out)
	if err == nil {
		t.Fatal("a 426 answer must be an error")
	}
	if kind := apiFailureKind(err); kind != "cli-too-old" {
		t.Fatalf("apiFailureKind(426) = %q, want cli-too-old", kind)
	}
	var buf bytes.Buffer
	printFailure(&buf, err)
	got := buf.String()
	for _, want := range []string{entry[0], entry[1]} {
		if !strings.Contains(got, want) {
			t.Errorf("the printed failure must carry %q:\n%s", want, got)
		}
	}
	if strings.Contains(got, "api-refused") || strings.Contains(got, "The drive's api refused") {
		t.Errorf("a 426 must not surface as api-refused:\n%s", got)
	}
}

// stepClock returns a clock a test moves by hand.
func stepClock(t *testing.T, start time.Time) (func() time.Time, func(time.Duration)) {
	t.Helper()
	now := start
	return func() time.Time { return now },
		func(d time.Duration) { now = now.Add(d) }
}

func TestTheDailyNoticePrintsOnceADay(t *testing.T) {
	home := t.TempDir()
	path := updateCheckPath(home)
	now, step := stepClock(t, time.Unix(1_700_000_000, 0))
	asks := 0
	newer := func() (bool, error) {
		asks++
		return true, nil
	}
	run := func() string {
		var buf bytes.Buffer
		if !noticeUpdateOnceADay(updateNoticeOptions{
			home:         home,
			path:         path,
			now:          now,
			updateExists: newer,
			out:          &buf,
		}) {
			return ""
		}
		return buf.String()
	}

	if got := run(); got != updateNoticeWords+"\n" {
		t.Fatalf("the first run printed %q, want %q", got, updateNoticeWords+"\n")
	}
	if asks != 1 {
		t.Fatalf("the first run asked about an update %d times, want 1", asks)
	}
	if got := run(); got != "" {
		t.Fatalf("an immediate second run printed %q, want silence within the day", got)
	}
	if asks != 1 {
		t.Fatalf("the second run asked again (%d asks), want the cached check", asks)
	}
	step(24 * time.Hour)
	if got := run(); got != updateNoticeWords+"\n" {
		t.Fatalf("a day later printed %q, want the notice again", got)
	}
	if asks != 2 {
		t.Fatalf("the next-day run asked about an update %d times, want 2", asks)
	}

	// The state file says what happened, so the rule is checkable on disk.
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	var rec updateCheckRecord
	if err := json.Unmarshal(raw, &rec); err != nil {
		t.Fatalf("the state file is not a check record: %v", err)
	}
	if rec.NotifiedAt != now().Unix() {
		t.Errorf("the state file records notifiedAt %d, want %d", rec.NotifiedAt, now().Unix())
	}
}

func TestTheDailyNoticeStaysQuietWhenUpToDate(t *testing.T) {
	home := t.TempDir()
	now, step := stepClock(t, time.Unix(1_700_000_000, 0))
	asks := 0
	newer := func() (bool, error) {
		asks++
		return false, nil
	}
	run := func() string {
		var buf bytes.Buffer
		if !noticeUpdateOnceADay(updateNoticeOptions{home: home, now: now, updateExists: newer, out: &buf}) {
			return ""
		}
		return buf.String()
	}
	if got := run(); got != "" {
		t.Fatalf("an up-to-date drive printed %q, want silence", got)
	}
	step(24 * time.Hour)
	if got := run(); got != "" {
		t.Fatalf("an up-to-date drive a day later printed %q, want silence", got)
	}
	if asks != 2 {
		t.Errorf("the update question was asked %d times over two days, want 2", asks)
	}
}

func TestAFailedUpdateCheckIsQuietAndRetriedTomorrow(t *testing.T) {
	home := t.TempDir()
	path := updateCheckPath(home)
	now, step := stepClock(t, time.Unix(1_700_000_000, 0))
	asks := 0
	newer := func() (bool, error) {
		asks++
		return false, fmt.Errorf("the package manager would not answer")
	}
	run := func() string {
		var buf bytes.Buffer
		if !noticeUpdateOnceADay(updateNoticeOptions{home: home, path: path, now: now, updateExists: newer, out: &buf}) {
			return ""
		}
		return buf.String()
	}
	if got := run(); got != "" {
		t.Fatalf("a failed check printed %q, want silence", got)
	}
	if got := run(); got != "" {
		t.Fatalf("a second failed check printed %q, want silence", got)
	}
	if asks != 1 {
		t.Errorf("the failed check ran %d times within the day, want the cached 1", asks)
	}
	step(24 * time.Hour)
	if got := run(); got != "" {
		t.Fatalf("a failed check a day later printed %q, want silence", got)
	}
	if asks != 2 {
		t.Errorf("the failed check was not retried the next day (%d asks), want 2", asks)
	}
	// The written stamp carries a checked-at time and no printed notice, so
	// nothing pretends a check succeeded when it did not.
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	var rec updateCheckRecord
	if err := json.Unmarshal(raw, &rec); err != nil {
		t.Fatal(err)
	}
	if rec.CheckedAt != now().Unix() {
		t.Errorf("a failed check recorded checkedAt %d, want %d", rec.CheckedAt, now().Unix())
	}
}

func TestACorruptUpdateCheckFileCountsAsNeverChecked(t *testing.T) {
	home := t.TempDir()
	path := updateCheckPath(home)
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte("not json at all"), 0o644); err != nil {
		t.Fatal(err)
	}
	now, _ := stepClock(t, time.Unix(1_700_000_000, 0))
	var buf bytes.Buffer
	if !noticeUpdateOnceADay(updateNoticeOptions{
		home:         home,
		path:         path,
		now:          now,
		updateExists: func() (bool, error) { return true, nil },
		out:          &buf,
	}) {
		t.Fatal("a corrupt state file was treated as checked within the day; it must count as never checked")
	}
	if buf.String() != updateNoticeWords+"\n" {
		t.Errorf("printed %q, want the notice", buf.String())
	}
}

// TestUpdateExistsOn pins the production read to the route ask `drive
// update` uses: a machine whose package manager owns drive and reports it
// outdated gets yes; one with nothing newer gets no; and a binary no package
// manager owns (a checkout build) is a quiet no, not an error a status run
// would print.
func TestUpdateExistsOn(t *testing.T) {
	f := brewBins()
	newer, err := updateExistsOn(f.lookPath, f.capture)
	if err != nil {
		t.Fatalf("a brew install with nothing newer errored: %v", err)
	}
	if newer {
		t.Fatal("a brew install with nothing newer must answer no")
	}
	f.out["brew outdated --cask nish3451/tap/drive"] = "drive (1.0.0) < 1.1.0"
	newer, err = updateExistsOn(f.lookPath, f.capture)
	if err != nil {
		t.Fatalf("a brew install with an outdated cask errored: %v", err)
	}
	if !newer {
		t.Fatal("a brew install with an outdated cask must answer yes")
	}
	empty := &fakeBin{present: map[string]bool{}, out: map[string]string{}, err: map[string]error{}}
	newer, err = updateExistsOn(empty.lookPath, empty.capture)
	if err != nil {
		t.Fatalf("a binary no package manager owns errored: %v", err)
	}
	if newer {
		t.Fatal("a binary no package manager owns must answer no")
	}
}

// TestTwoStatusRunsPrintOneNotice is the drive#560 concurrency duty: the
// state file is read, the package manager is asked, and the state file is
// written, and on one machine two `drive status` commands can be in those
// three steps at the same time. Both read a yesterday stamp, both ask, and
// both print, so the run that loses the race must not print at all — the
// winner's write is what quiets it. This runs two goroutines against the
// production entry point, so the lock itself is what is being tested.
func TestTwoStatusRunsPrintOneNotice(t *testing.T) {
	home := t.TempDir()
	path := updateCheckPath(home)
	now, _ := stepClock(t, time.Unix(1_700_000_000, 0))
	inside := make(chan struct{}, 8)
	gate := make(chan struct{})
	newer := func() (bool, error) {
		// Hold the package-manager ask open, so the run that lost the lock
		// cannot finish before the winner has written state.
		inside <- struct{}{}
		<-gate
		return true, nil
	}
	var wg sync.WaitGroup
	var first, second bytes.Buffer
	run := func(printed *bytes.Buffer) {
		wg.Add(1)
		go func() {
			defer wg.Done()
			_ = noticeUpdateOnceADay(updateNoticeOptions{
				home:         home,
				path:         path,
				now:          now,
				updateExists: newer,
				out:          printed,
			})
		}()
	}
	run(&first)
	<-inside // the first run holds the lock and is inside the probe
	run(&second)
	// Give the losing run its whole window: it never reaches the probe, so
	// no second `inside` arrives and this sleep is what proves it did not.
	time.Sleep(100 * time.Millisecond)
	close(gate)
	wg.Wait()
	if count := strings.Count(first.String(), updateNoticeWords) + strings.Count(second.String(), updateNoticeWords); count != 1 {
		t.Fatalf("two simultaneous status runs printed %d notices, want 1\nfirst: %q\nsecond: %q", count, first.String(), second.String())
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	var rec updateCheckRecord
	if err := json.Unmarshal(raw, &rec); err != nil {
		t.Fatal(err)
	}
	if rec.NotifiedAt != now().Unix() {
		t.Errorf("the state records notifiedAt %d, want %d", rec.NotifiedAt, now().Unix())
	}
}

// TestAStateFileFromTheFutureCountsAsNeverChecked is the other half of the
// drive#560 notice's resilience: a state file this machine cannot possibly
// have written (a clock rolled back, a file copied from another machine)
// must not be read as "checked", because a stamp in the future is older than
// nothing and would silence the notice until the clock caught up with it.
func TestAStateFileFromTheFutureCountsAsNeverChecked(t *testing.T) {
	home := t.TempDir()
	path := updateCheckPath(home)
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		t.Fatal(err)
	}
	now, _ := stepClock(t, time.Unix(1_700_000_000, 0))
	for _, raw := range []string{
		`{"checkedAt": 9999999999, "notifiedAt": 0}`,
		`{"checkedAt": 0, "notifiedAt": 9999999999}`,
	} {
		if err := os.WriteFile(path, []byte(raw), 0o644); err != nil {
			t.Fatal(err)
		}
		var buf bytes.Buffer
		if !noticeUpdateOnceADay(updateNoticeOptions{
			home:         home,
			path:         path,
			now:          now,
			updateExists: func() (bool, error) { return true, nil },
			out:          &buf,
		}) {
			t.Errorf("state %s held the notice back; want it counted as never checked", raw)
		}
	}
}

func TestUpdateCheckPathSitsBesideTheVFSCache(t *testing.T) {
	home := t.TempDir()
	got := updateCheckPath(home)
	if filepath.Dir(got) != filepath.Dir(DefaultCacheDir(home)) {
		t.Errorf("updateCheckPath = %q, want it beside the vfs cache %q", got, filepath.Dir(DefaultCacheDir(home)))
	}
	if filepath.Base(got) != "update-check.json" {
		t.Errorf("updateCheckPath = %q, want the update-check.json name", got)
	}
}
