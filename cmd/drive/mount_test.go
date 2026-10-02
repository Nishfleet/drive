package main

// The mount speed hill-climb (drive issue #224).
//
// The issue asks for the speed half of the eval-design/hill-climbing post,
// applied to the mount: one change per round, every row re-measured, a change
// kept only when its target row improves by more than that row's measured
// noise and nothing else gets worse by more than noise. A held-out set uses
// different file sizes on the other network profile so a keep is not an
// overfit to the tuning sizes.
//
// It is a Go test rather than a script because this repo's speed numbers are
// produced by `go test` (#99, gated by test/benchmarks.test.mjs: "no helper
// script"): the suite the published figures come from, run with the same
// command a reader types. The two stock tools it drives are rclone's own
// `serve s3` (the stand-in storage the step-1 proof uses) and hyperfine, which
// the issue names for the statistics. Neither is reimplemented here.
//
// The loop is off unless DRIVE_HILL=1, so `go test ./...` and CI `-short`
// stay green. Run it:
//
//	DRIVE_HILL=1 go test ./cmd/drive -run TestMountSpeedHillClimb -v -timeout 45m
//	DRIVE_HILL=1 DRIVE_BENCH_RUNS=10 go test ./cmd/drive -run TestMountSpeedHillClimb -v -timeout 45m
//
// The simulated network is stock `tc netem`. netem and the FUSE mount both
// need a user namespace on this host, so the test re-execs inside
// `unshare -Urmn` (user, mount and network), which is what the stand-in mount
// proofs already do (issue #62; two-mount-sync.test.mjs).

import (
	"encoding/json"
	"fmt"
	"math"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"
)

// hillClimbFlag is one knob the climb is allowed to turn. env is the suffix
// after DRIVE_BENCH_ that VFSArgs reads, so a round's override is the same
// handle the product already carries.
type hillClimbFlag struct {
	name      string
	flag      string
	env       string
	baseline  string
	candidate string
	target    string // hillClimbRow.scenario this flag exists to move
}

func tunableFlags() []hillClimbFlag {
	return []hillClimbFlag{
		{name: "vfs-read-ahead", flag: "--vfs-read-ahead", env: "VFS_READ_AHEAD", baseline: vfsReadAheadValue, candidate: "0", target: "open-time"},
		{name: "vfs-read-chunk-size", flag: "--vfs-read-chunk-size", env: "VFS_READ_CHUNK_SIZE", baseline: vfsReadChunkSizeValue, candidate: "32M", target: "video-start"},
		{name: "vfs-read-chunk-streams", flag: "--vfs-read-chunk-streams", env: "VFS_READ_CHUNK_STREAMS", baseline: vfsReadChunkStreamsValue, candidate: "4", target: "video-start"},
		{name: "buffer-size", flag: "--buffer-size", env: "BUFFER_SIZE", baseline: vfsChunkStreamSize, candidate: "16M", target: "small-file-get-1mib"},
		{name: "transfers", flag: "--transfers", env: "TRANSFERS", baseline: vfsTransfersValue, candidate: "8", target: "small-file-put-4kib"},
	}
}

type hillClimbRow struct {
	scenario string
	metric   string
	set      string // "tune" or "hold"
	// seed runs once per stand-in, against storage, never inside the timing.
	seed func(t *testing.T, h *hillStandin)
	// prepare is hyperfine --prepare, empty when the timed command does not mutate.
	prepare func(h *hillStandin) string
	cmd     func(h *hillStandin) string
	// copies > 1 seeds name-0..name-(n-1) and times each with hyperfine
	// --parameter-list, so a folder rename never has to move the same
	// directory back (rclone's S3 backend errors Dir.Remove not empty).
	copies int
}

func hillClimbRows() []hillClimbRow {
	return []hillClimbRow{
		{
			scenario: "open-time", metric: "first-byte", set: "tune",
			seed: func(t *testing.T, h *hillStandin) { h.seed(t, "get.bin", 1<<20) },
			cmd:  func(h *hillStandin) string { return "head -c 1 " + h.shell(filepath.Join(h.mountDir, "get.bin")) + " >/dev/null" },
		},
		{
			scenario: "video-start", metric: "first-byte", set: "tune",
			seed: func(t *testing.T, h *hillStandin) { h.seed(t, "video.bin", 5<<30) },
			cmd:  func(h *hillStandin) string { return "head -c 1 " + h.shell(filepath.Join(h.mountDir, "video.bin")) + " >/dev/null" },
		},
		{
			scenario: "small-file-get-1mib", metric: "get", set: "tune",
			cmd: func(h *hillStandin) string { return "cat " + h.shell(filepath.Join(h.mountDir, "get.bin")) + " >/dev/null" },
		},
		{
			scenario: "small-file-put-4kib", metric: "put", set: "tune",
			seed: func(t *testing.T, h *hillStandin) { h.writeFixture(t, "put.bin", 4096) },
			cmd: func(h *hillStandin) string {
				return "cp " + h.shell(filepath.Join(h.root, "fixtures", "put.bin")) + " " + h.shell(filepath.Join(h.mountDir, "put.bin"))
			},
		},
		{
			scenario: "small-edit-64mb", metric: "append-4kib", set: "tune",
			seed: func(t *testing.T, h *hillStandin) {
				h.seed(t, "edit.bin", 64<<20)
				h.writeFixture(t, "edit.bin", 64<<20)
			},
			prepare: func(h *hillStandin) string {
				return "cp " + h.shell(filepath.Join(h.root, "fixtures", "edit.bin")) + " " + h.shell(filepath.Join(h.mountDir, "edit.bin"))
			},
			cmd: func(h *hillStandin) string { return "printf x >> " + h.shell(filepath.Join(h.mountDir, "edit.bin")) },
		},
		{
			scenario: "big-folder-rename", metric: "rename", set: "tune", copies: 10,
			seed: func(t *testing.T, h *hillStandin) { h.seedFolderCopies(t, "rename", 200, 10) },
			cmd: func(h *hillStandin) string {
				return "mv " + h.shell(filepath.Join(h.mountDir, "rename-{i}")) + " " + h.shell(filepath.Join(h.mountDir, "renamed-{i}"))
			},
		},
		// Held-out: different sizes, measured on the other network profile.
		{
			scenario: "open-time", metric: "first-byte", set: "hold",
			seed: func(t *testing.T, h *hillStandin) { h.seed(t, "hold-get.bin", 512<<10) },
			cmd:  func(h *hillStandin) string { return "head -c 1 " + h.shell(filepath.Join(h.mountDir, "hold-get.bin")) + " >/dev/null" },
		},
		{
			scenario: "video-start", metric: "first-byte", set: "hold",
			seed: func(t *testing.T, h *hillStandin) { h.seed(t, "hold-video.bin", 64<<20) },
			cmd:  func(h *hillStandin) string { return "head -c 1 " + h.shell(filepath.Join(h.mountDir, "hold-video.bin")) + " >/dev/null" },
		},
		{
			scenario: "small-file-get-1mib", metric: "get", set: "hold",
			cmd: func(h *hillStandin) string { return "cat " + h.shell(filepath.Join(h.mountDir, "hold-get.bin")) + " >/dev/null" },
		},
		{
			scenario: "small-file-put-4kib", metric: "put", set: "hold",
			seed: func(t *testing.T, h *hillStandin) { h.writeFixture(t, "hold-put.bin", 8192) },
			cmd: func(h *hillStandin) string {
				return "cp " + h.shell(filepath.Join(h.root, "fixtures", "hold-put.bin")) + " " + h.shell(filepath.Join(h.mountDir, "hold-put.bin"))
			},
		},
		{
			scenario: "small-edit-64mb", metric: "append-4kib", set: "hold",
			seed: func(t *testing.T, h *hillStandin) {
				h.seed(t, "hold-edit.bin", 32<<20)
				h.writeFixture(t, "hold-edit.bin", 32<<20)
			},
			prepare: func(h *hillStandin) string {
				return "cp " + h.shell(filepath.Join(h.root, "fixtures", "hold-edit.bin")) + " " + h.shell(filepath.Join(h.mountDir, "hold-edit.bin"))
			},
			cmd: func(h *hillStandin) string { return "printf x >> " + h.shell(filepath.Join(h.mountDir, "hold-edit.bin")) },
		},
		{
			scenario: "big-folder-rename", metric: "rename", set: "hold", copies: 10,
			seed: func(t *testing.T, h *hillStandin) { h.seedFolderCopies(t, "hold-rename", 50, 10) },
			cmd: func(h *hillStandin) string {
				return "mv " + h.shell(filepath.Join(h.mountDir, "hold-rename-{i}")) + " " + h.shell(filepath.Join(h.mountDir, "hold-renamed-{i}"))
			},
		},
	}
}

type netemProfile struct {
	name string
	args []string
	set  string // "tune" or "hold": which row set this profile measures
}

func netemProfiles() []netemProfile {
	return []netemProfile{
		{name: "fast", args: []string{"delay", "0.1ms", "rate", "10gbit"}, set: "tune"},
		{name: "home-broadband", args: []string{"delay", "14ms", "rate", "200mbit"}, set: "hold"},
	}
}

func hillRuns(t *testing.T) int {
	if v := os.Getenv("DRIVE_BENCH_RUNS"); v != "" {
		n, err := strconv.Atoi(v)
		if err != nil || n < 1 {
			t.Fatalf("DRIVE_BENCH_RUNS=%q is not a positive count", v)
		}
		return n
	}
	return 10
}

type hillStandin struct {
	root     string
	home     string
	mountDir string
	cfg      StorageConfig
	serve    *exec.Cmd
	mount    *exec.Cmd
}

func (h *hillStandin) shell(p string) string {
	return "'" + strings.ReplaceAll(p, "'", `'\''`) + "'"
}

func (h *hillStandin) stopMount() {
	if h.mount == nil || h.mount.Process == nil {
		return
	}
	_ = h.mount.Process.Signal(os.Interrupt)
	done := make(chan struct{})
	go func() { _, _ = h.mount.Process.Wait(); close(done) }()
	select {
	case <-done:
	case <-time.After(10 * time.Second):
		_ = h.mount.Process.Kill()
		<-done
	}
	h.mount = nil
	_ = exec.Command("fusermount3", "-u", h.mountDir).Run()
	_ = exec.Command("fusermount", "-u", h.mountDir).Run()
}

func (h *hillStandin) close() {
	h.stopMount()
	if h.serve == nil || h.serve.Process == nil {
		return
	}
	_ = h.serve.Process.Signal(os.Interrupt)
	done := make(chan struct{})
	go func() { _, _ = h.serve.Process.Wait(); close(done) }()
	select {
	case <-done:
	case <-time.After(10 * time.Second):
		_ = h.serve.Process.Kill()
		<-done
	}
}

func (h *hillStandin) writeFixture(t *testing.T, name string, size int64) {
	t.Helper()
	p := filepath.Join(h.root, "fixtures", name)
	if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := writePatternFile(p, size); err != nil {
		t.Fatal(err)
	}
}

func (h *hillStandin) seed(t *testing.T, name string, size int64) {
	t.Helper()
	h.writeFixture(t, name, size)
	h.rclone(t, "copyto", filepath.Join(h.root, "fixtures", name), RemoteFor(h.cfg)+"/"+name)
}

func (h *hillStandin) seedFolder(t *testing.T, name string, n int) {
	t.Helper()
	local := filepath.Join(h.root, "fixtures", name)
	if err := os.MkdirAll(local, 0o755); err != nil {
		t.Fatal(err)
	}
	for i := range n {
		p := filepath.Join(local, fmt.Sprintf("file-%05d.bin", i))
		if _, err := os.Stat(p); err == nil {
			continue
		}
		if err := os.WriteFile(p, []byte(fmt.Sprintf("file %05d\n", i)), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	h.rclone(t, "copy", local, RemoteFor(h.cfg)+"/"+name)
}

func (h *hillStandin) seedFolderCopies(t *testing.T, name string, nfiles, copies int) {
	t.Helper()
	h.seedFolder(t, name+"-0", nfiles)
	src := RemoteFor(h.cfg) + "/" + name + "-0"
	for i := 1; i < copies; i++ {
		h.rclone(t, "copy", src, RemoteFor(h.cfg)+"/"+fmt.Sprintf("%s-%d", name, i))
	}
}

func (h *hillStandin) rclone(t *testing.T, args ...string) {
	t.Helper()
	cmd := exec.Command("rclone", args...)
	cmd.Env = append(os.Environ(), "RCLONE_CONFIG="+RcloneConfigPath(h.home))
	if b, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("rclone %s: %v\n%s", strings.Join(args, " "), err, b)
	}
}

type hyperfineStats struct {
	Mean   float64 `json:"mean"`
	Stddev float64 `json:"stddev"`
	Min    float64 `json:"min"`
}

type hillResult struct {
	scenario string
	metric   string
	set      string
	profile  string
	flags    string
	stats    hyperfineStats
	runs     int
}

func (r hillResult) key() string { return r.set + "\t" + r.scenario + "\t" + r.metric }

func noiseFloor(got, base hillResult) float64 {
	noise := base.stats.Stddev
	if got.stats.Stddev > noise {
		noise = got.stats.Stddev
	}
	if noise == 0 {
		noise = 0.0005
	}
	return noise
}

func worseThan(got, base hillResult) (bool, float64) {
	noise := noiseFloor(got, base)
	delta := got.stats.Mean - base.stats.Mean
	return got.stats.Mean > base.stats.Mean+noise, delta
}

func betterThan(got, base hillResult) (bool, float64) {
	noise := noiseFloor(got, base)
	delta := got.stats.Mean - base.stats.Mean
	return got.stats.Mean < base.stats.Mean-noise, delta
}

type benchKV struct {
	Scenario  string  `json:"scenario"`
	Metric    string  `json:"metric"`
	Set       string  `json:"set,omitempty"`
	Profile   string  `json:"profile,omitempty"`
	Flags     string  `json:"flags,omitempty"`
	Runs      int     `json:"runs"`
	MeanS     float64 `json:"mean_s"`
	StddevS   float64 `json:"stddev_s"`
	MinS      float64 `json:"min_s"`
	Commit    string  `json:"commit"`
	Timestamp string  `json:"timestamp"`
}

func (k benchKV) String() string {
	s := fmt.Sprintf("scenario=%s metric=%s set=%s mean=%.4f unit=s stddev=%.4f min=%.4f runs=%d commit=%s",
		k.Scenario, k.Metric, k.Set, k.MeanS, k.StddevS, k.MinS, k.Runs, k.Commit)
	if k.Profile != "" {
		s += " profile=" + k.Profile
	}
	if k.Flags != "" {
		s += " flags=" + strconv.Quote(k.Flags)
	}
	if k.Timestamp != "" {
		s += " at=" + k.Timestamp
	}
	return s
}

func TestVFSArgsPinsTheSafetyFlags(t *testing.T) {
	args := VFSArgs()
	for _, tc := range []struct {
		flag  string
		value string
	}{
		{"--vfs-cache-mode", vfsCacheModeValue},
		{"--vfs-write-back", vfsWriteBackValue},
		{"--vfs-cache-max-size", vfsCacheMaxValue},
		{"--dir-cache-time", vfsDirCacheTimeValue},
	} {
		if !hasArgPair(args, tc.flag, tc.value) {
			t.Errorf("mount args %v: %s must stay %q (issue #224 guardrails: no change may trade away safety)", args, tc.flag, tc.value)
		}
	}
	for _, f := range tunableFlags() {
		if !hasArgPair(args, f.flag, f.baseline) {
			t.Errorf("mount args %v: the tunable flag %s is not carried with its shipped value %q", args, f.flag, f.baseline)
		}
	}
}

func TestTunedVFSValueOverride(t *testing.T) {
	t.Setenv("DRIVE_BENCH_VFS_READ_AHEAD", "1M")
	args := VFSArgs()
	if !hasArgPair(args, "--vfs-read-ahead", "1M") {
		t.Fatalf("DRIVE_BENCH_VFS_READ_AHEAD did not retune --vfs-read-ahead:\n%v", args)
	}
	if !hasArgPair(args, "--vfs-write-back", vfsWriteBackValue) {
		t.Fatalf("an override moved a safety flag:\n%v", args)
	}
	if !hasArgPair(args, "--vfs-cache-max-size", vfsCacheMaxValue) {
		t.Fatalf("an override moved the cache ceiling:\n%v", args)
	}
}

func TestTunedVFSValueEmptyFallsBackToShipped(t *testing.T) {
	t.Setenv("DRIVE_BENCH_VFS_READ_AHEAD", "   ")
	args := VFSArgs()
	if !hasArgPair(args, "--vfs-read-ahead", vfsReadAheadValue) {
		t.Fatalf("empty DRIVE_BENCH_VFS_READ_AHEAD must keep the shipped value %s:\n%v", vfsReadAheadValue, args)
	}
}

func TestFlagPairsEnvUsesTheProductHandle(t *testing.T) {
	env, err := flagPairsEnv([][]string{{"--vfs-read-ahead", "0"}, {"--transfers", "8"}})
	if err != nil {
		t.Fatal(err)
	}
	got := strings.Join(env, " ")
	if !strings.Contains(got, "DRIVE_BENCH_VFS_READ_AHEAD=0") {
		t.Errorf("env %v missing DRIVE_BENCH_VFS_READ_AHEAD=0", env)
	}
	if !strings.Contains(got, "DRIVE_BENCH_TRANSFERS=8") {
		t.Errorf("env %v missing DRIVE_BENCH_TRANSFERS=8", env)
	}
	if _, err := flagPairsEnv([][]string{{"--vfs-write-back", "1s"}}); err == nil {
		t.Fatal("a safety flag must not be overridable through the climb handle")
	}
	if _, err := flagPairsEnv([][]string{{"--transfers", "abc"}}); err == nil {
		t.Fatal("a non-numeric candidate must be refused before rclone sees it")
	}
}

func TestRenameCmdPutsTheHyperfineParameterInsideTheQuotedPath(t *testing.T) {
	h := &hillStandin{mountDir: "/tmp/Drive"}
	for _, row := range hillClimbRows() {
		if row.copies < 2 {
			continue
		}
		cmd := row.cmd(h)
		if !strings.Contains(cmd, "'/tmp/Drive/") || !strings.Contains(cmd, "-{i}'") {
			t.Fatalf("parameterised cmd must quote the path with {{i}} inside: %s", cmd)
		}
	}
}

func TestMountSpeedHillClimb(t *testing.T) {
	if testing.Short() {
		t.Skip("hill-climb skipped in -short mode")
	}
	if os.Getenv("DRIVE_HILL") != "1" {
		t.Skip("set DRIVE_HILL=1 to run the mount speed hill-climb")
	}
	for _, bin := range []string{"rclone", "hyperfine", "unshare"} {
		if _, err := exec.LookPath(bin); err != nil {
			t.Fatalf("%s is not installed: %v", bin, err)
		}
	}
	tcPath := lookTc()
	if tcPath == "" {
		t.Fatal("tc is not installed: netem is the stock network simulator issue #224 names")
	}
	tcBin = tcPath
	if os.Getenv("DRIVE_BENCH_NS") != "1" {
		if err := reexecInNetNamespace(); err != nil {
			t.Fatalf("cannot run the climb in its own user/mount/network namespace: %v", err)
		}
		return
	}
	// A fresh network namespace has loopback down. The stand-in and the mount
	// both bind 127.0.0.1, and netem is attached to lo, so bring it up first.
	bringUpLoopback(t)

	runs := hillRuns(t)
	allRows := hillClimbRows()
	profiles := netemProfiles()
	flags := tunableFlags()
	start := time.Now()
	results := map[string]hillResult{}

	measure := func(profile netemProfile, label string, pairs [][]string, h *hillStandin) []hillResult {
		h.stopMount()
		for _, row := range allRows {
			if row.set == profile.set && row.copies > 1 && row.seed != nil {
				row.seed(t, h)
			}
		}
		h.remount(t, pairs)
		var out []hillResult
		for _, row := range allRows {
			if row.set != profile.set {
				continue
			}
			prepare := ""
			if row.prepare != nil {
				prepare = row.prepare(h)
			}
			stats, err := hyperfine(t, runs, prepare, row.cmd(h), row.copies)
			if err != nil {
				t.Fatalf("%s/%s set=%s on %s flags=%s: %v", row.scenario, row.metric, row.set, profile.name, label, err)
			}
			res := hillResult{scenario: row.scenario, metric: row.metric, set: row.set, profile: profile.name, flags: label, stats: stats, runs: runs}
			out = append(out, res)
			results[res.key()+"\t"+res.profile] = res
			t.Logf("bench %s", benchKV{
				Scenario: row.scenario, Metric: row.metric, Set: row.set, Profile: profile.name, Flags: label,
				Runs: runs, MeanS: stats.Mean, StddevS: stats.Stddev, MinS: stats.Min,
				Commit: benchCommit(), Timestamp: time.Now().UTC().Format(time.RFC3339),
			}.String())
		}
		return out
	}

	type round struct {
		flag   string
		from   string
		to     string
		keep   bool
		reason string
	}
	var rounds []round

	for _, profile := range profiles {
		setNetem(t, profile)
		t.Cleanup(func() {
			_ = exec.Command(tcBin, "qdisc", "del", "dev", "lo", "root").Run()
		})
		h := startStandin(t, allRows, profile.set)
		base := measure(profile, "shipped", nil, h)
		t.Logf("profile=%s set=%s flags=shipped rows=%d", profile.name, profile.set, len(base))
		for _, f := range flags {
			pairs := [][]string{{f.flag, f.candidate}}
			got := measure(profile, f.name+"="+f.candidate, pairs, h)
			keep := true
			reason := "target improved, no row worse than noise, held-out did not regress"
			var targetFound bool
			for _, r := range got {
				var b hillResult
				found := false
				for _, cand := range base {
					if cand.key() == r.key() {
						b = cand
						found = true
						break
					}
				}
				if !found {
					t.Fatalf("no baseline for %s on %s", r.key(), profile.name)
				}
				if r.scenario == f.target {
					targetFound = true
					if ok, delta := betterThan(r, b); !ok {
						keep = false
						reason = fmt.Sprintf("target %s did not beat noise (delta=%.4fs noise=%.4fs)", r.key(), delta, noiseFloor(r, b))
					}
				}
				if worse, delta := worseThan(r, b); worse {
					keep = false
					reason = fmt.Sprintf("%s is %.4fs worse than shipped (noise=%.4fs)", r.key(), delta, noiseFloor(r, b))
				}
			}
			if !targetFound {
				keep = false
				reason = "target row was not measured on this profile"
			}
			verdict := "REVERT"
			if keep {
				verdict = "KEEP"
			}
			t.Logf("%s profile=%s flag=%s %s->%s: %s", verdict, profile.name, f.name, f.baseline, f.candidate, reason)
			rounds = append(rounds, round{flag: f.name + "=" + f.candidate, from: f.baseline, to: f.candidate, keep: keep, reason: profile.name + ": " + reason})
		}
		h.close()
	}

	t.Logf("hill-climb finished in %s: %d measurements (runs=%d)", time.Since(start).Round(time.Second), len(results), runs)
	t.Log("ROUND TABLE (keep a flag only when BOTH profiles said KEEP)")
	byFlag := map[string][]round{}
	for _, r := range rounds {
		byFlag[r.flag] = append(byFlag[r.flag], r)
	}
	for _, f := range flags {
		key := f.name + "=" + f.candidate
		rs := byFlag[key]
		both := len(rs) == len(profiles)
		for _, r := range rs {
			if !r.keep {
				both = false
			}
		}
		verdict := "REVERT"
		if both && len(rs) > 0 {
			verdict = "KEEP"
			if f.baseline != f.candidate {
				t.Errorf("hill-climb kept %s=%s but config still ships %s; update the constant", f.name, f.candidate, f.baseline)
			}
		}
		t.Logf("FINAL %s %s %s->%s", verdict, f.name, f.baseline, f.candidate)
		for _, r := range rs {
			t.Logf("  %s", r.reason)
		}
	}
}

func hyperfine(t *testing.T, runs int, prepare, cmd string, copies int) (hyperfineStats, error) {
	t.Helper()
	jsonPath := filepath.Join(t.TempDir(), "hyperfine.json")
	args := []string{"--style", "basic", "--export-json", jsonPath}
	if copies > 1 {
		ids := make([]string, copies)
		for i := range copies {
			ids[i] = strconv.Itoa(i)
		}
		// Each copy is a fresh folder, so the first timed run is the
		// measurement. Warmup would consume a copy. Noise is the spread
		// across the ten copies (combineStats).
		args = append(args, "--warmup", "0", "--runs", "1", "--parameter-list", "i", strings.Join(ids, ","))
	} else {
		args = append(args, "--warmup", "2", "--runs", strconv.Itoa(runs))
		if prepare != "" {
			args = append(args, "--prepare", prepare)
		}
	}
	args = append(args, "--", cmd)
	out, err := exec.Command("hyperfine", args...).CombinedOutput()
	if err != nil {
		return hyperfineStats{}, fmt.Errorf("hyperfine: %w\n%s", err, out)
	}
	data, err := os.ReadFile(jsonPath)
	if err != nil {
		return hyperfineStats{}, err
	}
	var doc struct {
		Results []hyperfineStats `json:"results"`
	}
	if err := json.Unmarshal(data, &doc); err != nil {
		return hyperfineStats{}, err
	}
	if len(doc.Results) == 0 {
		return hyperfineStats{}, fmt.Errorf("hyperfine exported no results:\n%s", out)
	}
	return combineStats(doc.Results), nil
}

func combineStats(rs []hyperfineStats) hyperfineStats {
	if len(rs) == 1 {
		return rs[0]
	}
	sum := 0.0
	min := rs[0].Min
	for _, r := range rs {
		sum += r.Mean
		if r.Min < min {
			min = r.Min
		}
	}
	mean := sum / float64(len(rs))
	ss := 0.0
	for _, r := range rs {
		d := r.Mean - mean
		ss += d * d
	}
	return hyperfineStats{Mean: mean, Stddev: math.Sqrt(ss / float64(len(rs))), Min: min}
}

func startStandin(t *testing.T, rows []hillClimbRow, set string) *hillStandin {
	t.Helper()
	root := t.TempDir()
	h := &hillStandin{root: root, home: filepath.Join(root, "home"), cfg: testStorage()}
	h.mountDir = filepath.Join(h.home, "Drive")
	if err := os.MkdirAll(h.mountDir, 0o755); err != nil {
		t.Fatal(err)
	}
	port := freePort(t)
	h.cfg.Endpoint = "http://127.0.0.1:" + port
	h.serve = exec.Command("rclone", "serve", "s3", filepath.Join(root, "data"),
		"--auth-key", h.cfg.AccessKey+","+h.cfg.SecretKey,
		"--addr", "127.0.0.1:"+port, "--log-level", "ERROR")
	serveLog, err := os.Create(filepath.Join(root, "serve.out"))
	if err != nil {
		t.Fatal(err)
	}
	h.serve.Stdout, h.serve.Stderr = serveLog, serveLog
	if err := h.serve.Start(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(h.close)
	waitForPort(t, port)
	if err := WriteFileAtomic(RcloneConfigPath(h.home), []byte(RcloneConfig(h.cfg)), 0o600); err != nil {
		h.close()
		t.Fatal(err)
	}
	seen := map[string]bool{}
	for _, row := range rows {
		if row.set != set || row.seed == nil {
			continue
		}
		if seen[row.scenario] {
			continue
		}
		seen[row.scenario] = true
		row.seed(t, h)
	}
	return h
}

func (h *hillStandin) remount(t *testing.T, pairs [][]string) {
	t.Helper()
	h.stopMount()
	if err := os.MkdirAll(h.mountDir, 0o755); err != nil {
		t.Fatal(err)
	}
	cmd := exec.Command(driveBin(t), "mount",
		"--home", h.home, "--endpoint", h.cfg.Endpoint, "--bucket", h.cfg.Bucket,
		"--prefix", h.cfg.Prefix, "--foreground")
	cmd.Env = append(os.Environ(),
		"DRIVE_S3_ACCESS_KEY_ID="+h.cfg.AccessKey,
		"DRIVE_S3_SECRET_ACCESS_KEY="+h.cfg.SecretKey,
		// The climb measures VFS flags. Prefetch is a separate login item
		// (issue #227) and would list and warm files during the timed runs.
		"DRIVE_PREFETCH=0",
	)
	if len(pairs) > 0 {
		env, err := flagPairsEnv(pairs)
		if err != nil {
			h.close()
			t.Fatal(err)
		}
		cmd.Env = append(cmd.Env, env...)
	}
	logFile, err := os.Create(filepath.Join(h.root, "mount.out"))
	if err != nil {
		h.close()
		t.Fatal(err)
	}
	cmd.Stdout, cmd.Stderr = logFile, logFile
	if err := cmd.Start(); err != nil {
		logFile.Close()
		h.close()
		t.Fatal(err)
	}
	h.mount = cmd
	if !waitForMount(t, h.mount, h.mountDir) {
		_ = logFile.Close()
		log, _ := os.ReadFile(filepath.Join(h.root, "mount.out"))
		h.close()
		t.Fatalf("this host did not mount: the climb needs an unprivileged FUSE mount (unshare -Urmn)\n%s", log)
	}
}

func flagPairsEnv(pairs [][]string) ([]string, error) {
	var env []string
	for _, p := range pairs {
		if len(p) != 2 {
			return nil, fmt.Errorf("flag pair %v is not a flag and a value", p)
		}
		f, ok := tunableByFlag(p[0])
		if !ok {
			return nil, fmt.Errorf("%s is not one of the mount's tunable flags", p[0])
		}
		if strings.TrimSpace(p[1]) == "" {
			return nil, fmt.Errorf("%s has an empty candidate", p[0])
		}
		if !validClimbValue(p[1]) {
			return nil, fmt.Errorf("%s candidate %q is not a size or a count", p[0], p[1])
		}
		env = append(env, "DRIVE_BENCH_"+f.env+"="+p[1])
	}
	return env, nil
}

func validClimbValue(v string) bool {
	if v == "" {
		return false
	}
	n := 0
	for _, c := range v {
		if c >= '0' && c <= '9' {
			n++
			continue
		}
		break
	}
	if n == 0 {
		return false
	}
	rest := v[n:]
	switch rest {
	case "", "K", "M", "G", "T", "k", "m":
		return true
	}
	return false
}

func tunableByFlag(flag string) (hillClimbFlag, bool) {
	for _, f := range tunableFlags() {
		if f.flag == flag {
			return f, true
		}
	}
	return hillClimbFlag{}, false
}

var tcBin string

func lookTc() string {
	if p, err := exec.LookPath("tc"); err == nil {
		return p
	}
	for _, dir := range []string{"/sbin", "/usr/sbin", "/usr/local/sbin"} {
		p := filepath.Join(dir, "tc")
		if info, err := os.Stat(p); err == nil && !info.IsDir() {
			return p
		}
	}
	return ""
}

func setNetem(t *testing.T, p netemProfile) {
	t.Helper()
	_ = exec.Command(tcBin, "qdisc", "del", "dev", "lo", "root").Run()
	args := append([]string{"qdisc", "add", "dev", "lo", "root", "netem"}, p.args...)
	if out, err := exec.Command(tcBin, args...).CombinedOutput(); err != nil {
		t.Fatalf("apply %s: %v\n%s", p.name, err, out)
	}
}

func bringUpLoopback(t *testing.T) {
	t.Helper()
	ipBin := lookIp()
	if ipBin == "" {
		t.Fatal("ip is not installed: a net namespace needs it to bring loopback up")
	}
	if out, err := exec.Command(ipBin, "link", "set", "lo", "up").CombinedOutput(); err != nil {
		t.Fatalf("ip link set lo up: %v\n%s", err, out)
	}
}

func lookIp() string {
	if p, err := exec.LookPath("ip"); err == nil {
		return p
	}
	for _, dir := range []string{"/sbin", "/usr/sbin", "/usr/local/sbin"} {
		p := filepath.Join(dir, "ip")
		if info, err := os.Stat(p); err == nil && !info.IsDir() {
			return p
		}
	}
	return ""
}

func reexecInNetNamespace() error {
	exe, err := os.Executable()
	if err != nil {
		return err
	}
	args := append([]string{"-Urmn", exe}, os.Args[1:]...)
	cmd := exec.Command("unshare", args...)
	cmd.Env = append(os.Environ(), "DRIVE_BENCH_NS=1")
	cmd.Stdout, cmd.Stderr = os.Stdout, os.Stderr
	cmd.Stdin = strings.NewReader("")
	return cmd.Run()
}
