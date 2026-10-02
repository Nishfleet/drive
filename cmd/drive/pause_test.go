package main

import (
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// Unit tests for the rclone rc client and the pause state (drive issue #100).
// The rclone answers these decode are the real ones, measured on this host
// 2026-10-03 with rclone v1.75.1 against a `rclone serve s3` stand-in:
// core/bwlimit, vfs/queue and core/stats, with `eta` null when rclone cannot
// know it and `transferring` absent when nothing is in flight.

func TestRCSocketAndPauseStatePaths(t *testing.T) {
	home := filepath.Join("home", "me")
	if got := RCSocketPath(home); got != filepath.Join("home", "me", ".config", "drive", "rc.sock") {
		t.Errorf("RCSocketPath = %q, want the socket inside the 0700 config dir", got)
	}
	if got := PauseStatePath(home); got != filepath.Join("home", "me", ".config", "drive", "paused") {
		t.Errorf("PauseStatePath = %q, want the marker inside the config dir", got)
	}
	if rcAddr(RCSocketPath(home)) != "unix://"+RCSocketPath(home) {
		t.Errorf("rcAddr = %q, want the socket as a unix:// --rc-addr value", rcAddr(RCSocketPath(home)))
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

// startRCServer answers rc calls on a real unix socket, so the client under
// test dials the same kind of socket the mount creates, not a TCP listener.
func startRCServer(t *testing.T, handler http.HandlerFunc) string {
	t.Helper()
	socket := filepath.Join(t.TempDir(), "rc.sock")
	listener, err := net.Listen("unix", socket)
	if err != nil {
		t.Fatal(err)
	}
	srv := &http.Server{Handler: handler}
	go func() { _ = srv.Serve(listener) }()
	t.Cleanup(func() { _ = srv.Close() })
	return socket
}

func TestRCClientDecodesTheMeasuredBwLimit(t *testing.T) {
	var gotPath, gotBody string
	// rclone is stateful: setting a rate, then asking with no argument, answers
	// the rate now in force. The stand-in keeps the same state, so the test
	// walks the same path the CLI does.
	const rateOff = `{"bytesPerSecond":-1,"bytesPerSecondTx":-1,"bytesPerSecondRx":-1,"rate":"off"}`
	const rate1Ki = `{"bytesPerSecond":-1,"bytesPerSecondTx":1024,"bytesPerSecondRx":-1,"rate":"1Ki:off"}`
	inForce := rateOff
	socket := startRCServer(t, func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.Path
		body, _ := io.ReadAll(r.Body)
		gotBody = string(body)
		// Parse the body the same way rclone does, after keeping a copy for
		// the assertion: FormValue would read the body this handler already
		// consumed.
		values, _ := url.ParseQuery(gotBody)
		switch values.Get("rate") {
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
			if values.Get("rate") == pausedRate {
				inForce = rate1Ki
			} else {
				inForce = rateOff
			}
		}
		_, _ = w.Write([]byte(inForce))
	})
	c := newRCClient(socket)
	if err := c.SetBwLimit(pausedRate); err != nil {
		t.Fatalf("SetBwLimit: %v", err)
	}
	if gotPath != "/core/bwlimit" {
		t.Errorf("posted to %s, want /core/bwlimit", gotPath)
	}
	if !strings.Contains(gotBody, "rate=") {
		t.Errorf("body = %q, want the form-encoded rate rclone reads", gotBody)
	}
	limit, err := c.BwLimit()
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
	if err := c.SetBwLimit(resumeRate); err != nil {
		t.Fatalf("SetBwLimit(off): %v", err)
	}
	if got, err := c.BwLimit(); err != nil || got.Rate != "off" {
		t.Errorf("after resume rate = %q (err %v), want off", got.Rate, err)
	}
	// A refused call is a named failure, never an empty answer.
	if _, err := c.Post("core/bwlimit", map[string]string{"rate": "bad"}); err == nil {
		t.Error("got no error for rclone's error envelope, want a named failure")
	}
}

func TestRCClientSendsFormEncodedParams(t *testing.T) {
	var gotBody, gotContentType string
	socket := startRCServer(t, func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		gotBody = string(body)
		gotContentType = r.Header.Get("content-type")
		_, _ = w.Write([]byte(`{}`))
	})
	if err := newRCClient(socket).SetBwLimit(resumeRate); err != nil {
		t.Fatalf("SetBwLimit: %v", err)
	}
	if gotBody != "rate=off" {
		t.Errorf("body = %q, want rate=off, the form rclone reads", gotBody)
	}
	if gotContentType != "application/x-www-form-urlencoded" {
		t.Errorf("content-type = %q, want the form type", gotContentType)
	}
}

func TestRCClientNamesAnUnreachableSocket(t *testing.T) {
	err := newRCClient(filepath.Join(t.TempDir(), "not-there.sock")).SetBwLimit(pausedRate)
	if err == nil {
		t.Fatal("got no error for a socket that does not exist, want a named failure")
	}
	if !strings.Contains(err.Error(), "core/bwlimit") {
		t.Errorf("error %q does not name the rc method that failed", err)
	}
}

func TestReadQueueAndReadStatsDecodeTheMeasuredShapes(t *testing.T) {
	socket := startRCServer(t, func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/vfs/queue":
			_, _ = w.Write([]byte(`{"queue":[{"name":"a.bin","id":1,"size":10485760,"expiry":1.97,"tries":0,"delay":5,"uploading":false}]}`))
		case "/core/stats":
			_, _ = w.Write([]byte(`{"bytes":12120064,"totalBytes":157286400,"totalTransfers":1,"transfers":0,"eta":null,"transferring":[{"name":"big.bin","bytes":12120064,"size":157286400,"percentage":7,"eta":null,"speed":0}]}`))
		default:
			http.NotFound(w, r)
		}
	})
	c := newRCClient(socket)
	queue, err := c.ReadQueue()
	if err != nil {
		t.Fatal(err)
	}
	if len(queue.Queue) != 1 || queue.Queue[0].Name != "a.bin" || queue.Queue[0].Size != 10485760 || queue.Queue[0].Uploading {
		t.Errorf("queue decoded to %+v, want a.bin, 10485760 bytes, not uploading", queue.Queue)
	}
	stats, err := c.ReadStats()
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
	socket := startRCServer(t, func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(`{}`))
	})
	queue, err := newRCClient(socket).ReadQueue()
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
	for _, bad := range []string{"a\nb", "a\rb"} {
		if got := uploadFileName(bad); got != "(name withheld)" {
			t.Errorf("uploadFileName(%q) = %q, want the name withheld", bad, got)
		}
	}
}

// TestMountPlanCarriesTheRemoteControlSocket proves a freshly written mount
// starts rclone with its rc socket, so pause, resume and the progress lines
// have a running mount to ask.
func TestMountPlanCarriesTheRemoteControlSocket(t *testing.T) {
	home := filepath.Join("home", "me")
	plan := BuildMountPlan("linux", home, "rclone", StorageConfig{Endpoint: "http://127.0.0.1:1", Bucket: "b", Prefix: "u/me"})
	joined := strings.Join(plan.Args(), " ")
	for _, want := range []string{"--rc", "--rc-addr", "unix://" + RCSocketPath(home), "--rc-no-auth"} {
		if !strings.Contains(joined, want) {
			t.Errorf("mount args %q do not carry %q", joined, want)
		}
	}
	// A drive that was never paused mounts at full speed: the plan must not
	// carry a limit that was never asked for.
	if strings.Contains(joined, "--bwlimit") {
		t.Errorf("mount args %q carry a bwlimit for an unpaused drive", joined)
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
// the first-run page and the usage page use (src/status.js UPLOAD_LABEL). The
// page is JavaScript and cannot import the Go, and the Go cannot import the
// page, so this test is the join between the two copies, the same join
// TestUploadLabelMatchesThePageWords runs for the queue words.
func TestStatusWordsMatchThePageWords(t *testing.T) {
	page, err := os.ReadFile(filepath.Join("..", "..", "src", "status.js"))
	if err != nil {
		t.Fatal(err)
	}
	html := string(page)
	for _, want := range []string{pausedLabel, resumedLabel, `"Paused"`, `"Resumed"`} {
		if !strings.Contains(html, want) {
			t.Errorf("src/status.js no longer carries %q; the pages and the CLI must show the same word for the same state", want)
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
	if err := runPause([]string{"--home", home}); err != nil {
		t.Fatalf("runPause: %v", err)
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
	if got := transfersLine(home, false, RCSocketPath(home)); got != transfersNotMounted {
		t.Errorf("transfersLine(not mounted) = %q, want %q", got, transfersNotMounted)
	}
	if err := SetPaused(home); err != nil {
		t.Fatal(err)
	}
	if got := transfersLine(home, true, RCSocketPath(home)); got != "transfers: "+pausedLabel {
		t.Errorf("transfersLine(paused) = %q, want the Paused word", got)
	}
	if got := transfersLine(home, false, RCSocketPath(home)); got != transfersNotMounted {
		t.Errorf("transfersLine(paused but not mounted) = %q, want %q", got, transfersNotMounted)
	}
	if err := ClearPaused(home); err != nil {
		t.Fatal(err)
	}
	// Mounted, not paused, no socket to ask: rclone is running its own default
	// rate, which is full speed.
	if got := transfersLine(home, true, RCSocketPath(home)); got != transfersRunning {
		t.Errorf("transfersLine(running) = %q, want %q", got, transfersRunning)
	}
	// Mounted with a live socket whose rate is off: still running.
	socket := startRCServer(t, func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(`{"rate":"off"}`))
	})
	if got := transfersLine(home, true, socket); got != transfersRunning {
		t.Errorf("transfersLine(rc says off) = %q, want %q", got, transfersRunning)
	}
}

func TestTransfersLineNamesALimitedRateInsteadOfGuessing(t *testing.T) {
	home := t.TempDir()
	socket := startRCServer(t, func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(`{"rate":"500k"}`))
	})
	got := transfersLine(home, true, socket)
	if !strings.Contains(got, "500k") {
		t.Errorf("transfersLine(limited) = %q, want the rate rclone reports", got)
	}
	if !strings.Contains(got, "limited") {
		t.Errorf("transfersLine(limited) = %q, want it named as a limit rather than full speed", got)
	}
}

// ptrFloat is a helper for the eta cases: rclone's eta is a pointer because it
// answers null when it cannot know.
func ptrFloat(v float64) *float64 { return &v }
