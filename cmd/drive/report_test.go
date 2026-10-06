package main

import (
	"context"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// Unit tests for the live upload-queue report (drive issue #318). The rclone
// answers these decode are the real ones, measured on this host 2026-10-03 with
// rclone v1.75.1 against a `rclone serve s3` stand-in, and the client reaches
// rclone the way the product does — by running the rclone binary — so the
// stand-in is the same tiny shim pause_test.go uses.

// TestQueueReportFromTheMeasuredShapes is the join between rclone's two
// answers and the report body: the queue's size is the total, the in-flight
// bytes of the file also in the queue are what has gone up, and the file count
// is the queue length. The numbers are the same ones `drive status` prints in
// its per-file block (cmd/drive/status.go formatRCProgress), so a report and
// the local line cannot disagree.
func TestQueueReportFromTheMeasuredShapes(t *testing.T) {
	queue := Queue{Queue: []QueueItem{
		{Name: "shape.bin", Size: 10485760, Uploading: true},
		{Name: "notes.txt", Size: 4096, Uploading: false},
	}}
	stats := Stats{
		Bytes:        12120064,
		TotalBytes:   157286400,
		Transferring: []Transfer{{Name: "big.bin", Bytes: 12120064, Size: 157286400, Percentage: 7}},
	}
	got := queueReportFrom(queue, stats, false)
	if got.Files != 2 {
		t.Errorf("files = %d, want 2", got.Files)
	}
	// big.bin is not in the queue, so its 12,120,064 bytes are not counted.
	if got.UploadedBytes != 0 {
		t.Errorf("uploadedBytes = %d, want 0: the transferring file is not in the queue", got.UploadedBytes)
	}
	if got.TotalBytes != 10489856 {
		t.Errorf("totalBytes = %d, want 10489856 (the queue's two sizes)", got.TotalBytes)
	}
	if got.Paused {
		t.Error("paused = true, want false")
	}

	// The in-flight file that is also in the queue contributes its bytes up.
	stats.Transferring = []Transfer{{Name: "shape.bin", Bytes: 4194304, Size: 10485760, Percentage: 40}}
	got = queueReportFrom(queue, stats, true)
	if got.UploadedBytes != 4194304 {
		t.Errorf("uploadedBytes = %d, want 4194304 (the in-flight bytes of the queued file)", got.UploadedBytes)
	}
	if got.TotalBytes != 10489856 {
		t.Errorf("totalBytes = %d, want 10489856", got.TotalBytes)
	}
	if !got.Paused {
		t.Error("paused = false, want true")
	}
}

// TestQueueReportUploadedNeverPassesTheTotal is the invariant the endpoint
// holds (workers/api/src/queue-routes.js parseQueueReport): a queue whose
// in-flight bytes passed the queue's total would be refused, so it is clamped
// here rather than sent.
func TestQueueReportUploadedNeverPassesTheTotal(t *testing.T) {
	queue := Queue{Queue: []QueueItem{{Name: "shape.bin", Size: 10485760}}}
	stats := Stats{Transferring: []Transfer{{Name: "shape.bin", Bytes: 20971520, Size: 20971520}}}
	got := queueReportFrom(queue, stats, false)
	if got.UploadedBytes > got.TotalBytes {
		t.Errorf("uploadedBytes = %d passes totalBytes = %d; the report is whole only inside the total", got.UploadedBytes, got.TotalBytes)
	}
	if got.UploadedBytes != got.TotalBytes {
		t.Errorf("uploadedBytes = %d, want %d (clamped to the total)", got.UploadedBytes, got.TotalBytes)
	}
}

// TestQueueReportOfAnEmptyQueue is the honest empty report: nothing waiting is
// a complete state, and the page renders it as "Up to date" rather than as a
// division by zero or a missing line.
func TestQueueReportOfAnEmptyQueue(t *testing.T) {
	got := queueReportFrom(Queue{Queue: []QueueItem{}}, Stats{}, false)
	if got.Files != 0 || got.UploadedBytes != 0 || got.TotalBytes != 0 || got.Paused {
		t.Errorf("an empty queue reported to %+v, want all zeroes", got)
	}
}

// writingCredentials puts a signed-in device's credentials on disk, so the
// reporter loop has an account and a token to report to.
func writingCredentials(t *testing.T, home, apiBase string) {
	t.Helper()
	if err := SaveCredentials(home, Credentials{APIBase: apiBase, DeviceToken: "dtok-test"}); err != nil {
		t.Fatal(err)
	}
}

// TestRunQueueReportLoopPostsTheQueue proves the loop reaches the Worker over
// the device token the credentials hold, with the body the api route reads:
// one tick, one POST, the JSON field names the Go and the Worker agree on
// without a second name list.
func TestRunQueueReportLoopPostsTheQueue(t *testing.T) {
	var gotPath, gotAuth, gotContentType, gotBody string
	var bodies []string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath, gotAuth, gotContentType = r.URL.Path, r.Header.Get("authorization"), r.Header.Get("content-type")
		data, err := io.ReadAll(r.Body)
		if err != nil {
			t.Errorf("read the request body: %v", err)
		}
		gotBody = string(data)
		if gotPath == "/v1/queue" {
			bodies = append(bodies, gotBody)
		}
		_, _ = w.Write([]byte(`{"reported":true,"reportedAt":1}`))
	}))
	t.Cleanup(server.Close)

	c := fakeRclone(t, func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/vfs/queue":
			_, _ = w.Write([]byte(`{"queue":[{"name":"shape.bin","id":1,"size":10485760,"expiry":1.97,"tries":0,"delay":5,"uploading":true}]}`))
		case "/core/stats":
			_, _ = w.Write([]byte(`{"bytes":4194304,"totalBytes":10485760,"totalTransfers":1,"transfers":0,"eta":null,"transferring":[{"name":"shape.bin","bytes":4194304,"size":10485760,"percentage":40,"eta":null,"speed":0}]}`))
		case "/core/bwlimit":
			_, _ = w.Write([]byte(`{"bytesPerSecond":-1,"bytesPerSecondTx":-1,"bytesPerSecondRx":-1,"rate":"off"}`))
		default:
			http.NotFound(w, r)
		}
	})

	home := t.TempDir()
	writingCredentials(t, home, server.URL)
	ctx, cancel := context.WithCancel(context.Background())
	errs := RunQueueReportLoop(ctx, c, home)
	// The first tick fires at the interval, so the loop is given one tick and
	// then stopped: the mount's own cancel is what ends it in production.
	timer := time.NewTimer(queueReportInterval + 2*time.Second)
	defer timer.Stop()
	select {
	case <-timer.C:
	case err := <-errs:
		t.Fatalf("the loop reported an error before its first tick: %v", err)
	}
	cancel()
	// The loop ends without an error, so the channel closes rather than a pass
	// having been dropped silently.
	for err := range errs {
		t.Errorf("the loop reported an error: %v", err)
	}

	if gotPath != "/v1/queue" {
		t.Fatalf("path = %q, want /v1/queue", gotPath)
	}
	if gotAuth != "Bearer dtok-test" {
		t.Errorf("authorization = %q, want the device token as a bearer", gotAuth)
	}
	if !strings.HasPrefix(gotContentType, "application/json") {
		t.Errorf("content-type = %q, want JSON", gotContentType)
	}
	want := `{"files":1,"uploadedBytes":4194304,"totalBytes":10485760,"paused":false}`
	if gotBody != want {
		t.Errorf("body = %s, want %s", gotBody, want)
	}
}

// TestRunQueueReportLoopIsDormantWithoutCredentials is the device that has not
// signed in: nothing to report to, so the loop ends without an error and the
// mount keeps running.
func TestRunQueueReportLoopIsDormantWithoutCredentials(t *testing.T) {
	c := fakeRclone(t, func(w http.ResponseWriter, r *http.Request) {
		http.NotFound(w, r)
	})
	home := t.TempDir()
	errs := RunQueueReportLoop(context.Background(), c, home)
	timer := time.NewTimer(2 * time.Second)
	defer timer.Stop()
	select {
	case <-timer.C:
		t.Fatal("the loop never ended on a home with no credentials")
	case err, open := <-errs:
		if err != nil {
			t.Errorf("the dormant loop reported %v, want no error", err)
		}
		if open {
			t.Error("the channel stayed open after the dormant loop ended")
		}
	}
}

// TestRunQueueReportLoopNamesAWorkerRefusal is the failure path: the Worker
// refuses the report (429 inside the interval, say), and the loop says so on
// the error channel with a named cause instead of going quiet. After the
// delight pass (drive#117) a person reads the table's words and the Worker's
// own sentence, and the raw 429 stays in the error chain for DRIVE_DEBUG.
func TestRunQueueReportLoopNamesAWorkerRefusal(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusTooManyRequests)
		_, _ = w.Write([]byte(`{"error":"Report again in 7 seconds."}`))
	}))
	t.Cleanup(server.Close)
	c := fakeRclone(t, func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/vfs/queue", "/core/stats", "/core/bwlimit":
			_, _ = w.Write([]byte(`{}`))
		default:
			http.NotFound(w, r)
		}
	})
	home := t.TempDir()
	writingCredentials(t, home, server.URL)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	errs := RunQueueReportLoop(ctx, c, home)
	timer := time.NewTimer(queueReportInterval + 2*time.Second)
	defer timer.Stop()
	select {
	case <-timer.C:
		t.Fatal("no error was reported for a Worker refusal")
	case err, open := <-errs:
		if !open {
			t.Fatal("the channel closed instead of reporting the refusal")
		}
		if !strings.Contains(err.Error(), "queue report") {
			t.Errorf("error = %v, want the queue-report label", err)
		}
		if !strings.Contains(err.Error(), "The drive's api refused the request.") {
			t.Errorf("error = %v, want the table's refused words", err)
		}
		if !strings.Contains(err.Error(), "Report again in 7 seconds.") {
			t.Errorf("error = %v, want the Worker's own sentence", err)
		}
		var apiErr *APIError
		if !errors.As(err, &apiErr) || !strings.Contains(apiErr.Status, "429") {
			t.Errorf("the refusal's 429 is not in the error chain: %v", err)
		}
	}
}

// TestRunQueueReportLoopNamesAWorkerThatDoesNotAnswer is the mount that is up
// and the Worker that is not: the loop keeps running and names the failure
// rather than stopping.
func TestRunQueueReportLoopNamesAWorkerThatDoesNotAnswer(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {}))
	addr := strings.TrimPrefix(server.URL, "http://")
	t.Cleanup(server.Close)
	server.Close()
	c := fakeRclone(t, func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/vfs/queue", "/core/stats":
			_, _ = w.Write([]byte(`{}`))
		case "/core/bwlimit":
			_, _ = w.Write([]byte(`{"rate":"off"}`))
		}
	})
	home := t.TempDir()
	writingCredentials(t, home, "http://"+addr)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	errs := RunQueueReportLoop(ctx, c, home)
	timer := time.NewTimer(queueReportInterval + 2*time.Second)
	defer timer.Stop()
	select {
	case <-timer.C:
		t.Fatal("no error was reported for a Worker that does not answer")
	case err, open := <-errs:
		if !open {
			t.Fatal("the channel closed instead of reporting the failure")
		}
		if err == nil {
			t.Fatal("a nil error was reported")
		}
	}
}

// TestQueueReportIntervalMatchesTheApiRoute pins the CLI's report interval to
// the server's minimum spacing between two accepted reports
// (core/queues.js QUEUE_REPORT_INTERVAL_SECONDS). The api route
// refuses a report inside that interval, so a CLI that ticked faster than it
// would be refused every time and the pages would fall silent. The Go cannot
// import the page and the page cannot import the Go, so this test is the join
// the same way TestStatusWordsMatchThePageWords is.
func TestQueueReportIntervalMatchesTheApiRoute(t *testing.T) {
	source, err := os.ReadFile(filepath.Join("..", "..", "core", "queues.js"))
	if err != nil {
		t.Fatal(err)
	}
	const interval = "QUEUE_REPORT_INTERVAL_SECONDS = 10"
	if !strings.Contains(string(source), interval) {
		t.Errorf("core/queues.js no longer carries %q; the CLI's interval and the server's minimum spacing must be the same number", interval)
	}
	if queueReportInterval != 10*time.Second {
		t.Errorf("queueReportInterval = %v, want 10s, the number the api route enforces", queueReportInterval)
	}
}

func TestQueueReportSendsOnChangeOrHeartbeat(t *testing.T) {
	prev := QueueReport{Files: 1, TotalBytes: 10}
	sent := time.Unix(1_000, 0)
	now := sent.Add(time.Second)
	if !queueReportDue(&prev, sent, now, QueueReport{Files: 2, TotalBytes: 10}, true) {
		t.Error("a changed queue must be sent")
	}
	if queueReportDue(&prev, sent, now, prev, true) {
		t.Error("an unchanged queue must wait for the heartbeat")
	}
	if !queueReportDue(&prev, sent, sent.Add(queueReportHeartbeat), prev, true) {
		t.Error("the 5-minute heartbeat must send")
	}
	if !queueReportDue(&prev, time.Time{}, now, prev, false) {
		t.Error("the first report must send")
	}
	if queueReportHeartbeat != 5*time.Minute {
		t.Errorf("queueReportHeartbeat = %v, want 5m", queueReportHeartbeat)
	}
}
