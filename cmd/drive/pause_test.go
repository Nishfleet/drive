package main

import (
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
)

// Unit tests for the rclone rc client and the pause state (drive issue #100).
// The rclone answers these decode are the real ones, measured on this host
// 2026-10-03 with rclone v1.75.1 against a `rclone serve s3` stand-in:
// core/bwlimit, vfs/queue and core/stats, with `eta` null when rclone cannot
// know it and `transferring` absent when nothing is in flight.
//
// The client reaches rclone the way the product does — by running the rclone
// binary (`rclone rc --rc-addr ... METHOD k=v`, fill_run.go rcClient.call) —
// so a stand-in for the binary is a tiny shim that forwards the same call to
// the answers below. That keeps the argument vector, the form encoding and
// rclone's error envelope on the real code path rather than on a hand-written
// HTTP client the product never uses.

func TestPauseStatePathIsInsideTheConfigDir(t *testing.T) {
	home := filepath.Join("home", "me")
	if got := PauseStatePath(home); got != filepath.Join("home", "me", ".config", "drive", "paused") {
		t.Errorf("PauseStatePath = %q, want the marker inside the config dir", got)
	}
}

func TestPausedRateRoundTripsThroughTheMarker(t *testing.T) {
	home := t.TempDir()
	if Paused(home) {
		t.Error("a home with no marker reports paused")
	}
	if got := PausedRate(home); got != "" {
		t.Errorf("PausedRate = %q, want empty for a drive that was never paused", got)
	}
	if err := SetPaused(home); err != nil {
		t.Fatal(err)
	}
	if !Paused(home) {
		t.Error("Paused is false after SetPaused")
	}
	if got := PausedRate(home); got != pausedRate {
		t.Errorf("PausedRate = %q, want %q so the next mount starts paused", got, pausedRate)
	}
	if err := ClearPaused(home); err != nil {
		t.Fatal(err)
	}
	if Paused(home) {
		t.Error("Paused is true after ClearPaused")
	}
	// Clearing a drive that was never paused is not an error: running
	// `drive resume` twice must not fail.
	if err := ClearPaused(home); err != nil {
		t.Errorf("ClearPaused on an absent marker: %v", err)
	}
}

func TestPausedRateJunkFailsClosed(t *testing.T) {
	home := t.TempDir()
	path := PauseStatePath(home)
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		t.Fatal(err)
	}
	// "off" is rclone's full-speed word. A junk marker must not become that
	// rate on the next mount, or a pause would resume itself.
	if err := os.WriteFile(path, []byte("off\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if got := PausedRate(home); got != pausedRate {
		t.Errorf("PausedRate(junk) = %q, want %q so a restart stays paused", got, pausedRate)
	}
	if !Paused(home) {
		t.Error("a junk marker reports not paused")
	}
}

func TestRateIsPausedAcceptsBothSpellings(t *testing.T) {
	if !rateIsPaused(pausedRate) || !rateIsPaused(rclonePausedRate) {
		t.Error("the paused spellings we set and rclone reports must both count as paused")
	}
	if rateIsPaused(resumeRate) || rateIsPaused("") || rateIsPaused("1M:off") {
		t.Error("full speed and other rates must not count as paused")
	}
}

// fakeRclone points an rcClient at answers a test chooses. rclone is
// stateful, so the caller keeps the state the handler mutates, exactly as the
// stand-in rclone does. The shim is written into the test's own temp
// directory; nothing is added to the repository.
func fakeRclone(t *testing.T, handler http.HandlerFunc) *rcClient {
	t.Helper()
	srv := httptest.NewServer(handler)
	t.Cleanup(srv.Close)
	addr := strings.TrimPrefix(srv.URL, "http://")
	shim := filepath.Join(t.TempDir(), "rclone-shim")
	body := "#!/bin/sh\n" +
		"# Stand-in for the rclone binary: forward one `rc` call to the answers\n" +
		"# the test server is serving, so rcClient.call runs for real. Like the\n" +
		"# real rclone it exits non-zero when the answer is an error envelope.\n" +
		"while [ $# -gt 0 ]; do\n" +
		"  case \"$1\" in\n" +
		"    rc) shift ;;\n" +
		"    --rc-addr) addr=\"$2\"; shift 2 ;;\n" +
		"    --user|--pass|--rc-user|--rc-pass) shift 2 ;;\n" +
		"    *) break ;;\n" +
		"  esac\n" +
		"done\n" +
		"method=\"$1\"; shift\n" +
		"body=\"\"\n" +
		"for arg in \"$@\"; do\n" +
		"  if [ -n \"$body\" ]; then body=\"$body&$arg\"; else body=\"$arg\"; fi\n" +
		"done\n" +
		"if [ -n \"$body\" ]; then\n" +
		"  resp=$(curl -s -X POST -d \"$body\" \"http://$addr/$method\")\n" +
		"else\n" +
		"  resp=$(curl -s -X POST \"http://$addr/$method\")\n" +
		"fi\n" +
		"printf '%s' \"$resp\"\n" +
		"case \"$resp\" in\n" +
		"  *'\"error\"'*) exit 1 ;;\n" +
		"esac\n" +
		"exit 0\n"
	if err := os.WriteFile(shim, []byte(body), 0o755); err != nil {
		t.Fatal(err)
	}
	// The address the shim dials is read out of the args the client passes, so
	// the client is pointed at the test server through the same --rc-addr the
	// product puts on the mount.
	return newRCClient(shim, addr, "")
}

func TestRCClientDecodesTheMeasuredBwLimit(t *testing.T) {
	// mu guards the stand-in's state: it is written on the server's goroutine
	// and read here once each call returns.
	var mu sync.Mutex
	var gotPath, gotBody string
	seen := func() (string, string) {
		mu.Lock()
		defer mu.Unlock()
		return gotPath, gotBody
	}
	// rclone is stateful: setting a rate, then asking with no argument, answers
	// the rate now in force. The stand-in keeps the same state, so the test
	// walks the same path the CLI does.
	const rateOff = `{"bytesPerSecond":-1,"bytesPerSecondTx":-1,"bytesPerSecondRx":-1,"rate":"off"}`
	const rate1Ki = `{"bytesPerSecond":-1,"bytesPerSecondTx":1024,"bytesPerSecondRx":-1,"rate":"1Ki:off"}`
	inForce := rateOff
	c := fakeRclone(t, func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		defer mu.Unlock()
		gotPath = r.URL.Path
		if err := r.ParseForm(); err != nil {
			t.Errorf("the client did not form-encode the rate: %v", err)
		}
		gotBody = r.Form.Encode()
		switch r.Form.Get("rate") {
		case "bad":
			// rclone answers a refused call with 200 and an error key,
			// measured on this host 2026-10-03.
			_, _ = w.Write([]byte(`{"error": "couldn't parse rate", "input": {}, "path": "core/bwlimit", "status": 400}`))
			return
		case "":
			// No argument: rclone answers the rate in force.
			_, _ = w.Write([]byte(inForce))
			return
		default:
			if r.Form.Get("rate") == pausedRate {
				inForce = rate1Ki
			} else {
				inForce = rateOff
			}
		}
		_, _ = w.Write([]byte(inForce))
	})
	ctx, cancel := rcCtx()
	defer cancel()
	if err := c.SetBwLimit(ctx, pausedRate); err != nil {
		t.Fatalf("SetBwLimit: %v", err)
	}
	if path, body := seen(); path != "/core/bwlimit" || !strings.Contains(body, "rate=") {
		t.Errorf("posted %q to %s, want the form-encoded rate rclone reads at /core/bwlimit", body, path)
	}
	limit, err := c.BwLimit(ctx)
	if err != nil {
		t.Fatalf("BwLimit: %v", err)
	}
	if limit.Rate != "1Ki:off" {
		t.Errorf("rate = %q, want 1Ki:off, the measured paused rate", limit.Rate)
	}
	if limit.BytesPerSecondTx != 1024 {
		t.Errorf("bytesPerSecondTx = %d, want 1024: Tx is the upload half of UP:DOWN", limit.BytesPerSecondTx)
	}
	// Resume answers the rate that resumes, and a query answers it back.
	if err := c.SetBwLimit(ctx, resumeRate); err != nil {
		t.Fatalf("SetBwLimit(off): %v", err)
	}
	if got, err := c.BwLimit(ctx); err != nil || got.Rate != "off" {
		t.Errorf("after resume rate = %q (err %v), want off", got.Rate, err)
	}
	// A refused call is a named failure, never an empty answer.
	var reply map[string]any
	if err := c.call(ctx, "core/bwlimit", map[string]string{"rate": "bad"}, &reply); err == nil {
		t.Error("got no error for rclone's error envelope, want a named failure")
	}
}

func TestRCClientSendsFormEncodedParams(t *testing.T) {
	var gotBody string
	c := fakeRclone(t, func(w http.ResponseWriter, r *http.Request) {
		if err := r.ParseForm(); err != nil {
			t.Errorf("the client did not form-encode the rate: %v", err)
		}
		gotBody = r.Form.Encode()
		_, _ = w.Write([]byte(`{}`))
	})
	ctx, cancel := rcCtx()
	defer cancel()
	if err := c.SetBwLimit(ctx, resumeRate); err != nil {
		t.Fatalf("SetBwLimit: %v", err)
	}
	if gotBody != "rate=off" {
		t.Errorf("body = %q, want rate=off, the form rclone reads", gotBody)
	}
}

func TestRCClientNamesAnUnreachableMount(t *testing.T) {
	// A client whose shim is not executable runs nothing, so the call fails the
	// way a mount that never started fails: a named error, not an empty answer.
	c := newRCClient(filepath.Join(t.TempDir(), "not-there"), "127.0.0.1:1", "")
	ctx, cancel := rcCtx()
	defer cancel()
	if err := c.SetBwLimit(ctx, pausedRate); err == nil {
		t.Fatal("got no error for a client that cannot reach a mount, want a named failure")
	}
}

func TestReadQueueAndReadStatsDecodeTheMeasuredShapes(t *testing.T) {
	c := fakeRclone(t, func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/vfs/queue":
			_, _ = w.Write([]byte(`{"queue":[{"name":"a.bin","id":1,"size":10485760,"expiry":1.97,"tries":0,"delay":5,"uploading":false}]}`))
		case "/core/stats":
			_, _ = w.Write([]byte(`{"bytes":12120064,"totalBytes":157286400,"totalTransfers":1,"transfers":0,"eta":null,"transferring":[{"name":"big.bin","bytes":12120064,"size":157286400,"percentage":7,"eta":null,"speed":0}]}`))
		default:
			http.NotFound(w, r)
		}
	})
	ctx, cancel := rcCtx()
	defer cancel()
	queue, err := c.ReadQueue(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if len(queue.Queue) != 1 || queue.Queue[0].Name != "a.bin" || queue.Queue[0].Size != 10485760 || queue.Queue[0].Uploading {
		t.Errorf("queue decoded to %+v, want a.bin, 10485760 bytes, not uploading", queue.Queue)
	}
	stats, err := c.ReadStats(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if len(stats.Transferring) != 1 || stats.Transferring[0].Name != "big.bin" {
		t.Fatalf("transferring decoded to %+v, want big.bin", stats.Transferring)
	}
	if stats.Transferring[0].Percentage != 7 {
		t.Errorf("percentage = %d, want 7", stats.Transferring[0].Percentage)
	}
	// rclone's null eta is unknown, never zero.
	if stats.Transferring[0].Eta != nil {
		t.Errorf("eta decoded to %v, want nil for rclone's null", *stats.Transferring[0].Eta)
	}
}

func TestReadQueueTreatsAnAbsentQueueAsEmpty(t *testing.T) {
	c := fakeRclone(t, func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(`{}`))
	})
	ctx, cancel := rcCtx()
	defer cancel()
	queue, err := c.ReadQueue(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if queue.Queue == nil {
		t.Error("an absent queue key decoded to nil, want an empty queue")
	}
	if len(queue.Queue) != 0 {
		t.Errorf("an absent queue key decoded to %d items, want zero", len(queue.Queue))
	}
}

func TestHoldQueuedUploadsPostsQueueSetExpiry(t *testing.T) {
	var gotPath, gotID, gotExpiry string
	c := fakeRclone(t, func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/vfs/queue":
			_, _ = w.Write([]byte(`{"queue":[{"name":"a.bin","id":7,"size":10,"expiry":1.97,"tries":0,"delay":5,"uploading":false}]}`))
		case "/vfs/queue-set-expiry":
			gotPath = r.URL.Path
			if err := r.ParseForm(); err != nil {
				t.Errorf("the client did not form-encode the expiry: %v", err)
			}
			gotID = r.Form.Get("id")
			gotExpiry = r.Form.Get("expiry")
			_, _ = w.Write([]byte(`{}`))
		default:
			http.NotFound(w, r)
		}
	})
	ctx, cancel := rcCtx()
	defer cancel()
	if err := c.HoldQueuedUploads(ctx); err != nil {
		t.Fatal(err)
	}
	if gotPath != "/vfs/queue-set-expiry" {
		t.Errorf("posted to %s, want /vfs/queue-set-expiry", gotPath)
	}
	if gotID != "7" || gotExpiry != queueHoldExpiry {
		t.Errorf("id=%q expiry=%q, want 7 and the hold expiry", gotID, gotExpiry)
	}
}

func TestReleaseQueuedUploadsPostsANegativeExpiry(t *testing.T) {
	var gotExpiry string
	c := fakeRclone(t, func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/vfs/queue":
			_, _ = w.Write([]byte(`{"queue":[{"name":"a.bin","id":7,"size":10,"uploading":false}]}`))
		case "/vfs/queue-set-expiry":
			if err := r.ParseForm(); err != nil {
				t.Errorf("the client did not form-encode the expiry: %v", err)
			}
			gotExpiry = r.Form.Get("expiry")
			_, _ = w.Write([]byte(`{}`))
		default:
			http.NotFound(w, r)
		}
	})
	ctx, cancel := rcCtx()
	defer cancel()
	if err := c.ReleaseQueuedUploads(ctx); err != nil {
		t.Fatal(err)
	}
	if gotExpiry != queueReleaseExpiry {
		t.Errorf("expiry=%q, want the release expiry", gotExpiry)
	}
}

func TestEtaLabelRendersSecondsAsAReadableTime(t *testing.T) {
	cases := []struct {
		name string
		eta  *float64
		want string
	}{
		{"unknown", nil, "unknown"},
		{"now", ptrFloat(0), "0s"},
		{"seconds", ptrFloat(42), "42s"},
		{"minutes", ptrFloat(125), "2m 05s"},
		{"hours", ptrFloat(3725), "1h 02m"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := etaLabel(tc.eta); got != tc.want {
				t.Errorf("etaLabel(%v) = %q, want %q", tc.eta, got, tc.want)
			}
		})
	}
}

func TestFileSizeLabelRendersOneShortColumn(t *testing.T) {
	cases := []struct {
		bytes int64
		want  string
	}{
		{0, "0 B"},
		{512, "512 B"},
		{1024, "1.0 KiB"},
		{10 * 1024 * 1024, "10.0 MiB"},
		{1024 * 1024 * 1024, "1.0 GiB"},
	}
	for _, tc := range cases {
		if got := fileSizeLabel(tc.bytes); got != tc.want {
			t.Errorf("fileSizeLabel(%d) = %q, want %q", tc.bytes, got, tc.want)
		}
	}
}

func TestUploadFileNameWithholdsANameThatWouldBreakTheColumn(t *testing.T) {
	if got := uploadFileName("movie.mp4"); got != "movie.mp4" {
		t.Errorf("uploadFileName = %q, want the name as saved", got)
	}
	for _, bad := range []string{"a\nb", "a\rb", "a\tb", "a\x1bb"} {
		if got := uploadFileName(bad); got != "(name withheld)" {
			t.Errorf("uploadFileName(%q) = %q, want the name withheld", bad, got)
		}
	}
}

// TestMountPlanCarriesTheRemoteControl proves a freshly written mount starts
// rclone with its remote control bound to loopback (MountPlan.RCAddr), so pause,
// resume and the progress lines have a running mount to ask, and no second
// listener is added.
func TestMountPlanCarriesTheRemoteControl(t *testing.T) {
	home := filepath.Join("home", "me")
	plan := BuildMountPlan("linux", home, "rclone", StorageConfig{Endpoint: "http://127.0.0.1:1", Bucket: "b", Prefix: "u/me"})
	joined := strings.Join(plan.Args(), " ")
	for _, want := range []string{"--rc", "--rc-addr", loopbackRCAddr} {
		if !strings.Contains(joined, want) {
			t.Errorf("mount args %q do not carry %q", joined, want)
		}
	}
	if strings.Contains(joined, "--rc-no-auth") {
		t.Errorf("mount args %q still disable remote-control auth", joined)
	}
	// A drive that was never paused mounts at full speed: the plan must not
	// carry a limit that was never asked for.
	if strings.Contains(joined, "--bwlimit") {
		t.Errorf("mount args %q carry a bwlimit for an unpaused drive", joined)
	}
}

func TestPausedMountPlanKeepsTheOverriddenRCAddr(t *testing.T) {
	t.Setenv("DRIVE_RC_ADDR", "127.0.0.1:5599")
	home := t.TempDir()
	if err := SetPaused(home); err != nil {
		t.Fatal(err)
	}
	plan := BuildMountPlan("linux", home, "rclone", StorageConfig{Endpoint: "http://127.0.0.1:1", Bucket: "b", Prefix: "u/me"})
	joined := strings.Join(plan.Args(), " ")
	if !strings.Contains(joined, "127.0.0.1:5599") {
		t.Errorf("paused mount args %q dropped the overridden rc address", joined)
	}
	if !strings.Contains(joined, "--bwlimit") || !strings.Contains(joined, pausedRate) {
		t.Errorf("paused mount args %q dropped the paused rate", joined)
	}
}

// TestMountPlanCarriesThePausedRate proves the pause survives a restart of the
// mount: the rate is on rclone's own command line, so a mount started again
// after `drive pause` starts already paused and no person has to pause it a
// second time.
func TestMountPlanCarriesThePausedRate(t *testing.T) {
	home := t.TempDir()
	if err := SetPaused(home); err != nil {
		t.Fatal(err)
	}
	plan := BuildMountPlan("linux", home, "rclone", StorageConfig{Endpoint: "http://127.0.0.1:1", Bucket: "b", Prefix: "u/me"})
	args := plan.Args()
	found := false
	for i, a := range args {
		if a == "--bwlimit" && i+1 < len(args) && args[i+1] == pausedRate {
			found = true
		}
	}
	if !found {
		t.Errorf("mount args %q do not carry --bwlimit %s for a paused drive", args, pausedRate)
	}
}

// TestStatusWordsMatchThePageWords pins the CLI's transfer words to the ones
// the first-run page and the usage page use (core/status.js UPLOAD_LABEL). The
// page is JavaScript and cannot import the Go, and the Go cannot import the
// page, so this test is the join between the two copies, the same join
// TestUploadLabelMatchesThePageWords runs for the queue words.
func TestStatusWordsMatchThePageWords(t *testing.T) {
	page, err := os.ReadFile(filepath.Join("..", "..", "core", "status.js"))
	if err != nil {
		t.Fatal(err)
	}
	html := string(page)
	for _, want := range []string{pausedLabel, resumedLabel, `"Paused"`, `"Resumed"`} {
		if !strings.Contains(html, want) {
			t.Errorf("core/status.js no longer carries %q; the pages and the CLI must show the same word for the same state", want)
		}
	}
}

// TestRunPauseAndResumeWriteTheMarker proves the two commands leave the state
// the next mount reads, without needing a live rclone in a unit test. Pause is
// called with no mount (Mounted returns false on a host with no findmnt match),
// which is the state a person pausing a stopped drive is in, and the marker is
// still written.
func TestRunPauseAndResumeWriteTheMarker(t *testing.T) {
	home := t.TempDir()
	out := captureStdout(t, func() {
		if err := runPause([]string{"--home", home}); err != nil {
			t.Fatalf("runPause: %v", err)
		}
	})
	if !strings.Contains(out, "slowed") {
		t.Errorf("pause note = %q, want the words to say slowed", out)
	}
	if !Paused(home) {
		t.Error("runPause did not leave the paused marker")
	}
	// Running it twice is a state, not a failure.
	if err := runPause([]string{"--home", home}); err != nil {
		t.Fatalf("second runPause: %v", err)
	}
	if err := runResume([]string{"--home", home}); err != nil {
		t.Fatalf("runResume: %v", err)
	}
	if Paused(home) {
		t.Error("runResume did not clear the paused marker")
	}
	// Resuming something that is not paused is not a failure either.
	if err := runResume([]string{"--home", home}); err != nil {
		t.Fatalf("second runResume: %v", err)
	}
}

func TestPauseAndResumeRejectUnexpectedArguments(t *testing.T) {
	if err := runPause([]string{"extra"}); err == nil {
		t.Error("runPause accepted an unexpected argument")
	}
	if err := runResume([]string{"extra"}); err == nil {
		t.Error("runResume accepted an unexpected argument")
	}
}

func TestTransfersLineSaysPausedNotMountedAndRunning(t *testing.T) {
	home := t.TempDir()
	if got := transfersLine(home, false); got != transfersNotMounted {
		t.Errorf("transfersLine(not mounted) = %q, want %q", got, transfersNotMounted)
	}
	if err := SetPaused(home); err != nil {
		t.Fatal(err)
	}
	if got := transfersLine(home, false); got != "transfers: "+pausedLabel {
		t.Errorf("transfersLine(paused but not mounted) = %q, want the Paused word", got)
	}
	// Mounted with rclone unreachable falls back to the marker, so a pause
	// that cannot be confirmed still says Paused rather than unknown.
	t.Setenv("DRIVE_RCLONE", filepath.Join(t.TempDir(), "no-such-rclone"))
	if got := transfersLine(home, true); got != "transfers: "+pausedLabel {
		t.Errorf("transfersLine(paused, rclone missing) = %q, want the Paused word", got)
	}
	if err := ClearPaused(home); err != nil {
		t.Fatal(err)
	}
}

func TestTransfersLineTrustsTheLiveRateWhenMounted(t *testing.T) {
	home := t.TempDir()
	if err := SetPaused(home); err != nil {
		t.Fatal(err)
	}
	c := fakeRclone(t, func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(`{"rate":"off","bytesPerSecond":-1,"bytesPerSecondTx":-1,"bytesPerSecondRx":-1}`))
	})
	t.Setenv("DRIVE_RCLONE", c.binary)
	t.Setenv("DRIVE_RC_ADDR", c.addr)
	if got := transfersLine(home, true); got != transfersRunning {
		t.Errorf("transfersLine(mounted, live off, marker present) = %q, want running", got)
	}
}

func TestTransfersLineReadsPausedFromTheLiveRate(t *testing.T) {
	home := t.TempDir()
	c := fakeRclone(t, func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(`{"rate":"1Ki:off","bytesPerSecond":-1,"bytesPerSecondTx":1024,"bytesPerSecondRx":-1}`))
	})
	t.Setenv("DRIVE_RCLONE", c.binary)
	t.Setenv("DRIVE_RC_ADDR", c.addr)
	if got := transfersLine(home, true); got != "transfers: "+pausedLabel {
		t.Errorf("transfersLine(mounted, live paused, no marker) = %q, want the Paused word", got)
	}
}

func TestTransfersLineNamesALimitedRateInsteadOfGuessing(t *testing.T) {
	// A rate rclone did not set to off is not a full-speed upload, so the line
	// names the rate rather than reading as running. The rate comes from rclone
	// through the mount's remote control; with no rclone reachable the line is
	// the named unknown, never a guess.
	home := t.TempDir()
	t.Setenv("DRIVE_RCLONE", filepath.Join(t.TempDir(), "no-such-rclone"))
	if got := transfersLine(home, true); !strings.Contains(got, "unknown") {
		t.Errorf("transfersLine(no rclone) = %q, want a named unknown", got)
	}
}

func TestFormatRCProgressShowsNamePercentAndTotalLeft(t *testing.T) {
	eta := 125.0
	got := formatRCProgress(
		[]QueueItem{
			{Name: "shape.bin", Size: 10 * 1024 * 1024, Uploading: true},
			{Name: "notes.txt", Size: 1024, Uploading: false},
		},
		Stats{
			Transferring: []Transfer{
				{Name: "shape.bin", Bytes: 5 * 1024 * 1024, Size: 10 * 1024 * 1024, Percentage: 50, Eta: &eta},
			},
		},
	)
	if !strings.Contains(got, "shape.bin") || !strings.Contains(got, "50%") || !strings.Contains(got, "2m 05s left") {
		t.Errorf("in-flight line = %q, want name, percent and time left", got)
	}
	if !strings.Contains(got, "notes.txt") || !strings.Contains(got, "waiting") {
		t.Errorf("queued line = %q, want the waiting file named", got)
	}
	if !strings.Contains(got, "bytes left: 5.0 MiB") {
		t.Errorf("total = %q, want the bytes still to send", got)
	}
}

// ptrFloat is a helper for the eta cases: rclone's eta is a pointer because it
// answers null when it cannot know.
func ptrFloat(v float64) *float64 { return &v }
