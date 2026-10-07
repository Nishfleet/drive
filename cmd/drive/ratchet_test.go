package main

import (
	"encoding/json"
	"math"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"sort"
	"strconv"
	"testing"
	"time"
)

// The speed ratchet (drive issue #226). bench/baseline.json is the ceiling:
// a stand-in run that is slower than mean+noise fails, and a run that is
// faster than mean-noise fails until the same PR lowers the row. Hyperfine
// exports the CLI row; the mount rows are timed in this file against the
// loopback stand-in (DRIVE_BENCH_SCALE=quick). Both are stock tools, no
// helper script.

const ratchetRuns = 10

var ratchetRows = []string{
	"file-open",
	"video-start",
	"small-file-put",
	"small-file-get",
	"small-edit",
	"big-folder-rename",
	"mount-ready",
	"cli-cold-start",
}

type ratchetRow struct {
	Tool   string  `json:"tool"`
	Mean   float64 `json:"mean"`
	Stddev float64 `json:"stddev"`
	Runs   int     `json:"runs"`
}

type ratchetFile struct {
	Profile string                `json:"profile"`
	Network string                `json:"network"`
	Unit    string                `json:"unit"`
	Rows    map[string]ratchetRow `json:"rows"`
}

type hyperfineExport struct {
	Results []struct {
		Command string    `json:"command"`
		Mean    float64   `json:"mean"`
		Stddev  float64   `json:"stddev"`
		Times   []float64 `json:"times"`
	} `json:"results"`
}

func ratchetPath(t testing.TB) string {
	t.Helper()
	_, file, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("runtime.Caller")
	}
	return filepath.Join(filepath.Dir(file), "..", "..", "bench", "baseline.json")
}

func loadRatchet(t testing.TB) ratchetFile {
	t.Helper()
	raw, err := os.ReadFile(ratchetPath(t))
	if err != nil {
		t.Fatal(err)
	}
	var file ratchetFile
	if err := json.Unmarshal(raw, &file); err != nil {
		t.Fatal(err)
	}
	return file
}

// ratchetBand is the slowdown the row is meant to catch: the measured noise,
// at least 2 ms, because sub-millisecond opens are noisier than they are long.
func ratchetBand(row ratchetRow) float64 {
	if row.Stddev < 0.002 {
		return 0.002
	}
	return row.Stddev
}

// ratchetVerdict is the one rule: slower than mean+band is a regression;
// faster than mean-band means the PR must lower the checked-in row.
func ratchetVerdict(baseline, measured ratchetRow) string {
	band := ratchetBand(baseline)
	if measured.Mean > baseline.Mean+band {
		return "slower"
	}
	if measured.Mean < baseline.Mean-band {
		return "faster"
	}
	return "ok"
}

func meanSampleStd(xs []float64) (mean, stddev float64) {
	clipped := append([]float64(nil), xs...)
	sort.Float64s(clipped)
	if len(clipped) >= 8 {
		clipped = clipped[1 : len(clipped)-1]
	}
	n := float64(len(clipped))
	for _, x := range clipped {
		mean += x
	}
	mean /= n
	var v float64
	for _, x := range clipped {
		d := x - mean
		v += d * d
	}
	if n > 1 {
		stddev = math.Sqrt(v / (n - 1))
	}
	return mean, stddev
}

func TestRatchetDetectsADeliberateSleep(t *testing.T) {
	baseline := ratchetRow{Mean: 0.010, Stddev: 0.002, Runs: 10}
	// +50 ms, the issue's "added sleep on a branch".
	slower := ratchetRow{Mean: 0.010 + 0.050, Stddev: 0.002, Runs: 10}
	if g := ratchetVerdict(baseline, slower); g != "slower" {
		t.Fatalf("sleep-inflated row: verdict=%s, want slower", g)
	}
	within := ratchetRow{Mean: 0.011, Stddev: 0.001, Runs: 10}
	if g := ratchetVerdict(baseline, within); g != "ok" {
		t.Fatalf("within noise: verdict=%s, want ok", g)
	}
	faster := ratchetRow{Mean: 0.005, Stddev: 0.001, Runs: 10}
	if g := ratchetVerdict(baseline, faster); g != "faster" {
		t.Fatalf("faster than baseline: verdict=%s, want faster so the PR lowers the row", g)
	}
}

func TestRatchetBaselineHasEveryRow(t *testing.T) {
	file := loadRatchet(t)
	if file.Profile != "stand-in-quick" {
		t.Fatalf("profile=%q, want stand-in-quick", file.Profile)
	}
	if file.Network != "loopback" {
		t.Fatalf("network=%q, want loopback (the fixed profile)", file.Network)
	}
	if file.Unit != "s" {
		t.Fatalf("unit=%q, want s", file.Unit)
	}
	for _, id := range ratchetRows {
		row, ok := file.Rows[id]
		if !ok {
			t.Errorf("missing row %s", id)
			continue
		}
		if row.Runs < ratchetRuns {
			t.Errorf("%s: runs=%d, want >= %d", id, row.Runs, ratchetRuns)
		}
		if row.Mean <= 0 {
			t.Errorf("%s: mean=%g, want a measured second count", id, row.Mean)
		}
		if row.Stddev <= 0 {
			t.Errorf("%s: stddev=%g, want measured noise", id, row.Stddev)
		}
		if ratchetBand(row) >= math.Max(0.5*row.Mean, 0.05) {
			t.Errorf("%s: band %g is not smaller than the regression it is meant to catch (half of %.3fs, or 50ms)", id, ratchetBand(row), row.Mean)
		}
	}
}

func TestRatchetCLIColdStart(t *testing.T) {
	bin := driveBin(t)
	measured := timeCLIColdStart(t, bin)
	baseline, ok := loadRatchet(t).Rows["cli-cold-start"]
	if !ok {
		t.Fatal("cli-cold-start missing from bench/baseline.json")
	}
	if os.Getenv("GITHUB_ACTIONS") == "true" {
		// GitHub-hosted runners are not this VPS. Fail only a slowdown
		// the 50ms sleep proof would catch, not a 1 ms hardware delta.
		if measured.Mean > 0.05 {
			t.Errorf("cli-cold-start %.6fs is slower than the 50ms sleep proof", measured.Mean)
		}
		return
	}
	assertRatchet(t, "cli-cold-start", baseline, measured)
}

func timeCLIColdStart(t *testing.T, bin string) ratchetRow {
	t.Helper()
	if _, err := exec.LookPath("hyperfine"); err == nil {
		return timeCLIHyperfine(t, bin)
	}
	xs := make([]float64, ratchetRuns)
	for i := range xs {
		start := time.Now()
		cmd := exec.Command(bin, "version")
		if out, err := cmd.CombinedOutput(); err != nil {
			t.Fatalf("drive version: %v\n%s", err, out)
		}
		xs[i] = time.Since(start).Seconds()
	}
	mean, stddev := meanSampleStd(xs)
	return ratchetRow{Tool: "go-bench", Mean: mean, Stddev: stddev, Runs: ratchetRuns}
}

func timeCLIHyperfine(t *testing.T, bin string) ratchetRow {
	t.Helper()
	out := filepath.Join(t.TempDir(), "cli.json")
	cmd := exec.Command("hyperfine", "--runs", "10", "--warmup", "2", "--export-json", out, bin+" version")
	if b, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("hyperfine: %v\n%s", err, b)
	}
	raw, err := os.ReadFile(out)
	if err != nil {
		t.Fatal(err)
	}
	var exp hyperfineExport
	if err := json.Unmarshal(raw, &exp); err != nil {
		t.Fatal(err)
	}
	if len(exp.Results) != 1 {
		t.Fatalf("hyperfine results=%d, want 1", len(exp.Results))
	}
	r := exp.Results[0]
	if len(r.Times) < ratchetRuns {
		t.Fatalf("hyperfine times=%d, want >= %d", len(r.Times), ratchetRuns)
	}
	t.Logf("hyperfine command=%s mean=%.6f stddev=%.6f n=%d", r.Command, r.Mean, r.Stddev, len(r.Times))
	return ratchetRow{Tool: "hyperfine", Mean: r.Mean, Stddev: r.Stddev, Runs: len(r.Times)}
}

func assertRatchet(t *testing.T, id string, baseline, measured ratchetRow) {
	t.Helper()
	t.Logf("%s baseline=%.6f±%.6f measured=%.6f±%.6f n=%d", id, baseline.Mean, baseline.Stddev, measured.Mean, measured.Stddev, measured.Runs)
	switch ratchetVerdict(baseline, measured) {
	case "slower":
		t.Errorf("%s got slower than its noise: measured %.6fs > baseline %.6fs + %.6fs; the job fails so no change makes drive slower without CI saying so",
			id, measured.Mean, baseline.Mean, baseline.Stddev)
	case "faster":
		t.Errorf("%s got faster than its noise: measured %.6fs < baseline %.6fs - %.6fs; lower bench/baseline.json row %s in this PR",
			id, measured.Mean, baseline.Mean, baseline.Stddev, id)
	}
}

// TestSpeedRatchet runs the stand-in mount rows. It skips -short so the CI
// unit-test step stays inside its 10 minutes; the detector and the CLI row
// still run there. A follow-up with workflows permission adds
// `go test -run TestSpeedRatchet` as its own step (the worker App cannot
// write workflow files).
func TestSpeedRatchet(t *testing.T) {
	if testing.Short() {
		t.Skip("stand-in speed ratchet skipped in -short mode")
	}
	if os.Getenv("DRIVE_BENCH_SCALE") == "" {
		t.Setenv("DRIVE_BENCH_SCALE", "quick")
	}
	h := benchSetup(t)
	file := loadRatchet(t)
	record := os.Getenv("DRIVE_RATCHET_RECORD") == "1"

	type spec struct {
		id string
		op func()
	}
	const openName = "ratchet-open.bin"
	if err := h.seed(openName, 4096); err != nil {
		t.Fatal(err)
	}
	const videoName = "ratchet-video.bin"
	if err := h.seed(videoName, h.sizes.video); err != nil {
		t.Fatal(err)
	}
	const getName = "ratchet-get.bin"
	if err := h.seed(getName, 1<<20); err != nil {
		t.Fatal(err)
	}
	const editName = "ratchet-edit.bin"
	editSize := int64(32 << 20)
	if err := h.seed(editName, editSize); err != nil {
		t.Fatal(err)
	}
	for i := range ratchetRuns + 2 {
		if err := h.seedFolder("ratchet-ren-"+strconv.Itoa(i), 20); err != nil {
			t.Fatal(err)
		}
	}
	time.Sleep(6 * time.Second)

	specs := []spec{
		{"file-open", func() {
			f, err := os.Open(filepath.Join(h.mountDir, openName))
			if err != nil {
				t.Fatal(err)
			}
			f.Close()
		}},
		{"video-start", func() {
			f, err := os.Open(filepath.Join(h.mountDir, videoName))
			if err != nil {
				t.Fatal(err)
			}
			one := make([]byte, 1)
			if _, err := f.Read(one); err != nil {
				t.Fatal(err)
			}
			f.Close()
		}},
		{"small-file-get", func() {
			if _, err := os.ReadFile(filepath.Join(h.mountDir, getName)); err != nil {
				t.Fatal(err)
			}
		}},
	}

	for _, s := range specs {
		mean, stddev := timeSamples(ratchetRuns, 2, s.op)
		got := ratchetRow{Tool: "go-bench", Mean: mean, Stddev: stddev, Runs: ratchetRuns}
		t.Logf("RECORD %s mean=%.6f stddev=%.6f n=%d", s.id, mean, stddev, ratchetRuns)
		if record {
			continue
		}
		baseline, ok := file.Rows[s.id]
		if !ok {
			t.Errorf("missing baseline row %s", s.id)
			continue
		}
		assertRatchet(t, s.id, baseline, got)
	}

	rename := timeRatchetRename(t, h)
	t.Logf("RECORD big-folder-rename mean=%.6f stddev=%.6f n=%d", rename.Mean, rename.Stddev, rename.Runs)
	if !record {
		assertRatchet(t, "big-folder-rename", file.Rows["big-folder-rename"], rename)
	}

	put := timeRatchetPuts(t, h)
	t.Logf("RECORD small-file-put mean=%.6f stddev=%.6f n=%d", put.Mean, put.Stddev, put.Runs)
	if !record {
		assertRatchet(t, "small-file-put", file.Rows["small-file-put"], put)
	}

	edit := timeRatchetEdit(t, h, editName, editSize)
	t.Logf("RECORD small-edit mean=%.6f stddev=%.6f n=%d", edit.Mean, edit.Stddev, edit.Runs)
	if !record {
		assertRatchet(t, "small-edit", file.Rows["small-edit"], edit)
	}

	ready := timeRatchetMountReady(t, h)
	t.Logf("RECORD mount-ready mean=%.6f stddev=%.6f n=%d", ready.Mean, ready.Stddev, ready.Runs)
	if !record {
		assertRatchet(t, "mount-ready", file.Rows["mount-ready"], ready)
	}
}

func timeSamples(n, warmup int, op func()) (mean, stddev float64) {
	for range warmup {
		op()
	}
	xs := make([]float64, n)
	for i := range xs {
		start := time.Now()
		op()
		xs[i] = time.Since(start).Seconds()
	}
	return meanSampleStd(xs)
}

func timeRatchetRename(t *testing.T, h *benchStandin) ratchetRow {
	t.Helper()
	i := 0
	mean, stddev := timeSamples(ratchetRuns, 2, func() {
		src := filepath.Join(h.mountDir, "ratchet-ren-"+strconv.Itoa(i))
		dst := filepath.Join(h.mountDir, "ratchet-ren-"+strconv.Itoa(i)+"-dst")
		i++
		if err := os.Rename(src, dst); err != nil {
			t.Fatal(err)
		}
	})
	return ratchetRow{Tool: "go-bench", Mean: mean, Stddev: stddev, Runs: ratchetRuns}
}

func timeRatchetPuts(t *testing.T, h *benchStandin) ratchetRow {
	t.Helper()
	payload := make([]byte, 4096)
	i := 0
	mean, stddev := timeSamples(ratchetRuns, 2, func() {
		name := "ratchet-put-" + strconv.Itoa(i) + ".bin"
		i++
		if err := os.WriteFile(filepath.Join(h.mountDir, name), payload, 0o644); err != nil {
			t.Fatal(err)
		}
		if !h.waitStored(name, 4096, 2*time.Minute) {
			t.Fatal("the 4 KiB put never reached storage")
		}
	})
	return ratchetRow{Tool: "go-bench", Mean: mean, Stddev: stddev, Runs: ratchetRuns}
}

func timeRatchetEdit(t *testing.T, h *benchStandin, name string, size int64) ratchetRow {
	t.Helper()
	// Same clock as BenchmarkSmallEdit: append until the new size is in
	// storage, not until Close returns. A regression in write-back is a
	// slower save, and the scoreboard's competitor figure is the stored append.
	xs := make([]float64, ratchetRuns)
	want := size
	for i := range xs {
		f, err := os.OpenFile(filepath.Join(h.mountDir, name), os.O_APPEND|os.O_WRONLY, 0o644)
		if err != nil {
			t.Fatal(err)
		}
		start := time.Now()
		if _, err := f.Write(make([]byte, 4096)); err != nil {
			f.Close()
			t.Fatal(err)
		}
		f.Close()
		want += 4096
		if !h.waitStored(name, want, 2*time.Minute) {
			t.Fatal("the 4 KiB edit never reached storage")
		}
		xs[i] = time.Since(start).Seconds()
	}
	mean, stddev := meanSampleStd(xs)
	return ratchetRow{Tool: "go-bench", Mean: mean, Stddev: stddev, Runs: ratchetRuns}
}

func timeRatchetMountReady(t *testing.T, h *benchStandin) ratchetRow {
	t.Helper()
	xs := make([]float64, ratchetRuns)
	for i := range xs {
		home := filepath.Join(h.root, "home-ready-"+strconv.Itoa(i))
		mountDir := filepath.Join(home, "Drive")
		if err := os.MkdirAll(mountDir, 0o755); err != nil {
			t.Fatal(err)
		}
		if err := WriteFileAtomic(RcloneConfigPath(home), []byte(RcloneConfig(h.cfg)), 0o600); err != nil {
			t.Fatal(err)
		}
		start := time.Now()
		mount := exec.Command(driveBin(t), "mount", "--home", home, "--endpoint", h.cfg.Endpoint,
			"--bucket", h.cfg.Bucket, "--prefix", h.cfg.Prefix, "--foreground")
		mount.Env = append(os.Environ(),
			"DRIVE_S3_ACCESS_KEY_ID="+h.cfg.AccessKey,
			"DRIVE_S3_SECRET_ACCESS_KEY="+h.cfg.SecretKey,
		)
		mount.Stdout, mount.Stderr = os.Stdout, os.Stderr
		if err := mount.Start(); err != nil {
			t.Fatal(err)
		}
		ok := waitForMount(t, mount, mountDir)
		xs[i] = time.Since(start).Seconds()
		_ = mount.Process.Signal(os.Interrupt)
		done := make(chan struct{})
		go func() { _, _ = mount.Process.Wait(); close(done) }()
		select {
		case <-done:
		case <-time.After(10 * time.Second):
			_ = mount.Process.Kill()
			<-done
		}
		_ = exec.Command("fusermount3", "-u", mountDir).Run()
		_ = exec.Command("fusermount", "-u", mountDir).Run()
		if !ok {
			skipNoMount(t, "this host does not permit another unprivileged FUSE mount")
		}
	}
	mean, stddev := meanSampleStd(xs)
	return ratchetRow{Tool: "go-bench", Mean: mean, Stddev: stddev, Runs: ratchetRuns}
}
