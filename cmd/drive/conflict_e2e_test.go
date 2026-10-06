package main

import (
	"fmt"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// TestTwoDevicesKeepBothSaves is issue #30's finish line, on the same
// local `rclone serve s3` stand-in the other step-3 proofs use: two
// independent `rclone mount` processes, each a separate `drive mount`
// with its own home, config, prefix and VFS cache, sharing only the
// storage backend — which is exactly two machines.
//
//   - Two devices save the same file inside one sync window. Both
//     saves survive: the later one is the one plain file, the earlier
//     one lands as "name (conflict, <device>).ext", and both devices
//     can see both files through their mount, so both are notified.
//   - A save made while the device could not reach storage uploads
//     when it reconnects, and the same rule applies.
//
// It is skipped when this host will not bring up two unprivileged
// FUSE mounts (the skip message names why), because a proof of a
// mount is not a proof at all when the mount did not come up: two
// directories and an rclone that failed would produce a green run
// that proved nothing about a mounted path.
func TestTwoDevicesKeepBothSaves(t *testing.T) {
	if testing.Short() {
		t.Skip("stand-in proof skipped in -short mode")
	}
	root := t.TempDir()
	cfg, standin := standinOn(t, root, "u/conflict")
	restart := &standinRestart{serve: standin, root: root, cfg: cfg}
	// The device on which the conflict guard reads its own upload queue. The
	// mount uses the same remote control for the fill, the guard and status.
	t.Setenv(deviceEnvName, "mac")
	deviceA := DeviceName()

	homeA := filepath.Join(root, "home-a")
	mountA := filepath.Join(homeA, "Drive")
	homeB := filepath.Join(root, "home-b")
	mountB := filepath.Join(homeB, "Drive")
	for _, d := range []string{mountA, mountB} {
		if err := os.MkdirAll(d, 0o755); err != nil {
			t.Fatal(err)
		}
	}

	// Device B is its own machine: its own device name, so a conflict copy
	// names the device that lost the save and never the same one twice.
	// Each mount gets its own remote-control address: a FUSE mount is
	// isolated by the kernel, but a loopback port is a host resource, and two
	// mounts that both bind one address cannot both start.
	rcA, rcB := "127.0.0.1:"+freePort(t), "127.0.0.1:"+freePort(t)
	startDevice := func(home, device, rcAddrArg string) (stop func()) {
		t.Helper()
		cmd := exec.Command(driveBin(t), "mount",
			"--home", home, "--endpoint", cfg.Endpoint, "--bucket", cfg.Bucket,
			"--prefix", cfg.Prefix, "--foreground", "--device", device,
			"--rc-addr", rcAddrArg)
		cmd.Env = append(os.Environ(),
			"DRIVE_S3_ACCESS_KEY_ID="+cfg.AccessKey,
			"DRIVE_S3_SECRET_ACCESS_KEY="+cfg.SecretKey,
		)
		cmd.Stdout, cmd.Stderr = os.Stdout, os.Stderr
		if err := cmd.Start(); err != nil {
			t.Fatal(err)
		}
		mountDir := filepath.Join(home, "Drive")
		if !waitForMount(t, cmd, mountDir) {
			stopStandinProcess(cmd, mountDir)
			// The mount's own log is the real reason, not a guess: a reader of
			// this skip needs to know whether the host refused FUSE or the
			// mount had a bad argument.
			if log, err := os.ReadFile(filepath.Join(home, ".config", "drive", "mount.log")); err == nil {
				t.Logf("device %s mount log:\n%s", device, tailLines(string(log), 6))
			}
			skipNoMount(t, "this host will not bring up the %s mount (%s)", device, mountSkipReason())
		}
		return func() { stopStandinProcess(cmd, filepath.Join(home, "Drive")) }
	}
	stopA := startDevice(homeA, deviceA, rcA)
	defer stopA()
	stopB := startDevice(homeB, "linux", rcB)
	defer stopB()

	const name = "report.txt"
	const bodyA = "A: this save was made first, on the device named mac\n"
	const bodyB = "B: this save was made second, on the device named linux\n"

	// Both devices save the same path inside one sync window. Neither has
	// seen the other's write when it saves, so neither knows to do anything
	// other than save — the same situation two people have on two machines.
	if err := os.WriteFile(filepath.Join(mountA, name), []byte(bodyA), 0o644); err != nil {
		t.Fatal(err)
	}
	// One second later is still inside the 5s write-back window, and it
	// is how two people save: not the same millisecond. Two PUTs in the
	// same instant make rclone serve s3 answer "corrupted on transfer:
	// sizes differ" and retry in 10s, which is the flake on main
	// (baa4cfb) and the offline arm. The retry itself is
	// TestConflictGuardKeepsASaveThatLandsAfterARetry.
	time.Sleep(time.Second)
	if err := os.WriteFile(filepath.Join(mountB, name), []byte(bodyB), 0o644); err != nil {
		t.Fatal(err)
	}

	// The rule is decided after the uploads have landed: give the mount's
	// write-back (5s) and the guard its interval. The deadline is generous
	// on purpose — the proof is what was kept, not how fast.
	// Whichever save lands last is the plain file; the other is the conflict
	// copy, named for the device that lost it. Either device can lose: the
	// write-back timers are independent, so write order is not land order.
	// The rule is checked by what is kept rather than by who won.
	candidates := []string{ConflictName(name, deviceA), ConflictName(name, "linux")}
	kept, plain, conflict := waitForBothSavesInStorage(t, root, cfg, []string{mountA, mountB}, name, candidates,
		[]string{bodyA, bodyB}, 90*time.Second, "neither save survived")

	// Both devices are notified: the device that lost the save and the other
	// one both see both files through their own mount.
	waitUntilListed(t, []string{mountA, mountB}, []string{name, kept}, 90*time.Second)
	for _, m := range []struct{ label, dir string }{{"A", mountA}, {"B", mountB}} {
		got, err := os.ReadFile(filepath.Join(m.dir, kept))
		if err != nil {
			t.Fatalf("device %s cannot read the conflict copy: %v", m.label, err)
		}
		if string(got) != string(conflict) {
			t.Errorf("the conflict copy on device %s is %q, want %q", m.label, got, conflict)
		}
	}

	// And nothing was deleted: the losing device's file is a copy, not a
	// rename, so its own listing has both files.
	entries, err := os.ReadDir(mountA)
	if err != nil {
		t.Fatal(err)
	}
	var names []string
	for _, e := range entries {
		names = append(names, e.Name())
	}
	if len(names) != 2 {
		t.Errorf("device A's drive lists %v, want the plain file and the conflict copy", names)
	}
	t.Logf("two devices, one save window: storage=stand-in, plain=%q, conflict=%q, A's listing=%v",
		plain, kept, names)

	// -- the offline arm ---------------------------------------------------
	// The storage goes away and both devices save the same file while it is
	// unreachable. Nothing is uploaded while a device cannot reach storage,
	// and nothing is lost when it comes back: the uploads happen on
	// reconnect and the same rule decides what is kept.
	const offlineName = "offline.txt"
	const offlineA = "A: the save made while the device could not reach storage\n"
	const offlineB = "B: the save made while the device could not reach storage\n"
	if err := restart.stop(); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(mountA, offlineName), []byte(offlineA), 0o644); err != nil {
		t.Fatalf("save on device A while offline: %v", err)
	}
	time.Sleep(time.Second)
	if err := os.WriteFile(filepath.Join(mountB, offlineName), []byte(offlineB), 0o644); err != nil {
		t.Fatalf("save on device B while offline: %v", err)
	}
	if err := restart.start(t); err != nil {
		t.Fatal(err)
	}

	// Whichever save lands last is the plain file; the other is the conflict
	// copy, named for the device that lost it. Either device can lose, so the
	// rule is checked by what is kept rather than by who won.
	candidates = []string{ConflictName(offlineName, deviceA), ConflictName(offlineName, "linux")}
	kept, plain, conflict = waitForBothSavesInStorage(t, root, cfg, []string{mountA, mountB}, offlineName, candidates,
		[]string{offlineA, offlineB}, 90*time.Second,
		"the offline save never uploaded under the conflict rule")
	waitUntilListed(t, []string{mountA, mountB}, []string{offlineName, kept}, 90*time.Second)
	t.Logf("after the reconnect: plain=%q, conflict=%q, both saves kept", plain, conflict)
}

// startConflictDevice brings up one device's `drive mount` for cfg and returns
// its stop. Each device is its own machine: its own home, config, prefix and
// VFS cache, sharing only the storage backend, which is exactly two machines. A
// host that will not bring up an unprivileged FUSE mount skips the calling test
// naming the host's own constraint, because a proof of a mount is not a proof
// at all when the mount did not come up (the note on
// TestTwoDevicesKeepBothSaves).
func startConflictDevice(t *testing.T, cfg StorageConfig, home, device, rcAddr string) func() {
	t.Helper()
	cmd := exec.Command(driveBin(t), "mount",
		"--home", home, "--endpoint", cfg.Endpoint, "--bucket", cfg.Bucket,
		"--prefix", cfg.Prefix, "--foreground", "--device", device,
		"--rc-addr", rcAddr)
	cmd.Env = append(os.Environ(),
		"DRIVE_S3_ACCESS_KEY_ID="+cfg.AccessKey,
		"DRIVE_S3_SECRET_ACCESS_KEY="+cfg.SecretKey,
	)
	cmd.Stdout, cmd.Stderr = os.Stdout, os.Stderr
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	mountDir := filepath.Join(home, "Drive")
	if !waitForMount(t, cmd, mountDir) {
		stopStandinProcess(cmd, mountDir)
		// The mount's own log is the real reason, not a guess: a reader of this
		// skip needs to know whether the host refused FUSE or the mount had a
		// bad argument.
		if log, err := os.ReadFile(filepath.Join(home, ".config", "drive", "mount.log")); err == nil {
			t.Logf("device %s mount log:\n%s", device, tailLines(string(log), 6))
		}
		skipNoMount(t, "this host will not bring up the %s mount (%s)", device, mountSkipReason())
	}
	return func() { stopStandinProcess(cmd, mountDir) }
}

// TestTwoSavesSecondsApartInOneWindowBothSurvive proves the rule holds when the
// two saves are not in the same instant. One sync window is the mount's own
// 5-second write-back, so a save made two seconds after the other is still
// inside it: the first has not left its mount when the second one is made. Each
// device's upload leaves on its own timer, so the first device's save has
// already landed and its own object is the plain path when the second one lands
// on top of it.
//
// This is the case a same-instant proof cannot see, so it is its own proof.
func TestTwoSavesSecondsApartInOneWindowBothSurvive(t *testing.T) {
	if testing.Short() {
		t.Skip("stand-in proof skipped in -short mode")
	}
	root := t.TempDir()
	cfg, _ := standinOn(t, root, "u/conflict-gap")
	t.Setenv(deviceEnvName, "mac")
	deviceA := DeviceName()

	homeA := filepath.Join(root, "home-a")
	mountA := filepath.Join(homeA, "Drive")
	homeB := filepath.Join(root, "home-b")
	mountB := filepath.Join(homeB, "Drive")
	for _, d := range []string{mountA, mountB} {
		if err := os.MkdirAll(d, 0o755); err != nil {
			t.Fatal(err)
		}
	}
	rcA, rcB := "127.0.0.1:"+freePort(t), "127.0.0.1:"+freePort(t)
	stopA := startConflictDevice(t, cfg, homeA, deviceA, rcA)
	defer stopA()
	stopB := startConflictDevice(t, cfg, homeB, "linux", rcB)
	defer stopB()

	const name = "notes.txt"
	const bodyA = "A: saved first, a moment before the other device saved\n"
	const bodyB = "B: saved second, still inside the same sync window\n"
	if err := os.WriteFile(filepath.Join(mountA, name), []byte(bodyA), 0o644); err != nil {
		t.Fatal(err)
	}
	// Two seconds later: inside the mount's 5-second write-back window, so the
	// first save has not left device A when the second one is made.
	time.Sleep(2 * time.Second)
	if err := os.WriteFile(filepath.Join(mountB, name), []byte(bodyB), 0o644); err != nil {
		t.Fatal(err)
	}

	// Either device can be the one whose upload lands first, so the rule is
	// checked by what is kept rather than by who won.
	candidates := []string{ConflictName(name, deviceA), ConflictName(name, "linux")}
	kept, plain, _ := waitForBothSavesInStorage(t, root, cfg, []string{mountA, mountB}, name, candidates,
		[]string{bodyA, bodyB}, 90*time.Second, "one save was lost")
	// Both devices see both files that survived: the plain file and the one
	// conflict copy — named for whichever device lost. There is never one per
	// device; the two machines agreed on what to keep only by what landed on
	// top, which is exactly what cannot be faked by two directories.
	waitUntilListed(t, []string{mountA, mountB}, []string{name, kept}, 90*time.Second)
	entries, err := os.ReadDir(mountA)
	if err != nil {
		t.Fatal(err)
	}
	var names []string
	for _, e := range entries {
		names = append(names, e.Name())
	}
	if len(names) != 2 {
		t.Errorf("device A's drive lists %v, want the plain file and the conflict copy", names)
	}
	t.Logf("two saves seconds apart, one sync window: plain=%q, conflict=%q, A's listing=%v",
		plain, kept, names)
}

// standinObject is the file on the loopback server's disk for a drive-relative
// name: the object the conflict rule keeps.
func standinObject(root string, cfg StorageConfig, name string) string {
	return filepath.Join(root, "data", cfg.Bucket, cfg.Prefix, filepath.FromSlash(name))
}

// waitForBothSavesInStorage waits until the stand-in holds a conflict copy of
// name and returns that copy's name and both objects' bytes. The conflict rule
// is a rule about objects, so the proof reads the object store, not a mount
// whose VFS cache can still serve the losing device's own write (baa4cfb).
// mounts are polled too: a conflict name on a mount means the guard claimed,
// and Walk then finds the object if it sits under a different on-disk key.
func waitForBothSavesInStorage(t *testing.T, root string, cfg StorageConfig, mounts []string, name string, candidates, bodies []string, d time.Duration, missing string) (kept string, plain, conflict []byte) {
	t.Helper()
	deadline := time.Now().Add(d)
	var keptPath string
	var lastPlain, lastConflict []byte
	for time.Now().Before(deadline) {
		kept, keptPath = findStandinConflict(root, cfg, candidates)
		if kept == "" {
			for _, n := range candidates {
				for _, m := range mounts {
					if _, err := os.Stat(filepath.Join(m, n)); err == nil {
						kept = n
					}
				}
			}
		}
		if kept != "" {
			var err error
			plain, err = os.ReadFile(standinObject(root, cfg, name))
			if err == nil {
				if keptPath == "" {
					keptPath = standinObject(root, cfg, kept)
				}
				conflict, err = os.ReadFile(keptPath)
			}
			if err == nil {
				lastPlain, lastConflict = plain, conflict
				same := string(plain) == string(conflict)
				missingBody := false
				for _, want := range bodies {
					if string(plain) != want && string(conflict) != want {
						missingBody = true
					}
				}
				if !same && !missingBody {
					return kept, plain, conflict
				}
			}
		}
		time.Sleep(500 * time.Millisecond)
	}
	dumpStandinAndMounts(t, root, mounts)
	if len(lastPlain) > 0 || len(lastConflict) > 0 {
		t.Fatalf("%s: storage still had one save: plain=%q conflict=%q kept=%q",
			missing, lastPlain, lastConflict, kept)
	}
	t.Fatalf("%s: none of %v appeared in storage %s", missing, candidates, filepath.Join(root, "data", cfg.Bucket, cfg.Prefix))
	return "", nil, nil
}

// findStandinConflict is the conflict copy in the stand-in's object store:
// the expected key first, then any file under the bucket whose name is one
// of the candidates, so a layout difference is not a lost save.
func findStandinConflict(root string, cfg StorageConfig, candidates []string) (kept, path string) {
	for _, n := range candidates {
		p := standinObject(root, cfg, n)
		if fi, err := os.Stat(p); err == nil && !fi.IsDir() {
			return n, p
		}
	}
	want := make(map[string]string, len(candidates))
	for _, n := range candidates {
		want[filepath.Base(n)] = n
	}
	bucket := filepath.Join(root, "data", cfg.Bucket)
	_ = filepath.WalkDir(bucket, func(p string, d os.DirEntry, err error) error {
		if err != nil || d.IsDir() {
			return err
		}
		if n, ok := want[d.Name()]; ok {
			kept, path = n, p
			return filepath.SkipAll
		}
		return nil
	})
	return kept, path
}

func dumpStandinAndMounts(t *testing.T, root string, mounts []string) {
	t.Helper()
	var files []string
	_ = filepath.WalkDir(filepath.Join(root, "data"), func(p string, d os.DirEntry, err error) error {
		if err != nil || d.IsDir() {
			return err
		}
		rel, _ := filepath.Rel(root, p)
		files = append(files, rel)
		return nil
	})
	t.Logf("stand-in objects: %v", files)
	for _, m := range mounts {
		logPath := filepath.Join(filepath.Dir(m), ".config", "drive", "mount.log")
		if b, err := os.ReadFile(logPath); err == nil {
			t.Logf("mount log %s:\n%s", logPath, tailLines(string(b), 16))
		}
	}
}

// waitUntilListed waits until every dir lists every name, so both devices have
// been notified of the conflict copy.
func waitUntilListed(t *testing.T, dirs, names []string, d time.Duration) {
	t.Helper()
	deadline := time.Now().Add(d)
	for time.Now().Before(deadline) {
		ok := true
		for _, dir := range dirs {
			for _, n := range names {
				if _, err := os.Stat(filepath.Join(dir, n)); err != nil {
					ok = false
				}
			}
		}
		if ok {
			return
		}
		time.Sleep(500 * time.Millisecond)
	}
	t.Fatalf("the mounts did not list both files %v on %v", names, dirs)
}

// TestWaitForBothSavesInStorageReadsTheObjectStore proves the proof reads the
// winner from the object store when the losing mount still serves its own
// write at the plain path. That is the baa4cfb failure: both mount reads were
// the loser's bytes, and the winner was only in storage.
func TestWaitForBothSavesInStorageReadsTheObjectStore(t *testing.T) {
	root := t.TempDir()
	cfg := StorageConfig{Bucket: "bucket", Prefix: "u/conflict"}
	dir := filepath.Join(root, "data", cfg.Bucket, cfg.Prefix)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	const name = "report.txt"
	const bodyA = "A: this save was made first, on the device named mac\n"
	const bodyB = "B: this save was made second, on the device named linux\n"
	keptName := ConflictName(name, "linux")
	if err := os.WriteFile(filepath.Join(dir, name), []byte(bodyA), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, keptName), []byte(bodyB), 0o644); err != nil {
		t.Fatal(err)
	}
	kept, plain, conflict := waitForBothSavesInStorage(t, root, cfg, nil, name,
		[]string{ConflictName(name, "mac"), keptName},
		[]string{bodyA, bodyB}, time.Second, "neither save survived")
	if kept != keptName {
		t.Fatalf("kept %q, want %q", kept, keptName)
	}
	if string(plain) != bodyA {
		t.Fatalf("plain = %q, want the winner in storage", plain)
	}
	if string(conflict) != bodyB {
		t.Fatalf("conflict = %q, want the loser's copy in storage", conflict)
	}
}

// tailLines is the last n lines of s, so a skip message can carry the mount's
// own words instead of this test's guess at them.
func tailLines(s string, n int) string {
	lines := strings.Split(strings.TrimRight(s, "\n"), "\n")
	if len(lines) > n {
		lines = lines[len(lines)-n:]
	}
	return strings.Join(lines, "\n")
}

// standinRestart is the one stand-in server's stop and start. Stopping it
// is what a device that cannot reach storage has: the mount stays up and
// its writes are queued on the device. Starting it again is the reconnect,
// on the same endpoint and the same bucket, which is what makes the queue
// upload.
type standinRestart struct {
	serve *exec.Cmd
	root  string
	cfg   StorageConfig
}

// stop takes the storage away.
func (r *standinRestart) stop() error {
	if err := stopProcess(r.serve); err != nil {
		return fmt.Errorf("take the storage away: %w", err)
	}
	return nil
}

// start brings the same storage back, on the same endpoint.
func (r *standinRestart) start(t *testing.T) error {
	// The endpoint's own host and port are parsed rather than trimmed off
	// a prefix, because a trimmed string that is not an address produces
	// an rclone that never listens and a test that waits for a port that
	// was never the port being served.
	u, err := url.Parse(r.cfg.Endpoint)
	if err != nil {
		return fmt.Errorf("parse the stand-in endpoint %s: %w", r.cfg.Endpoint, err)
	}
	port := u.Port()
	if port == "" {
		return fmt.Errorf("the stand-in endpoint %s carries no port", r.cfg.Endpoint)
	}
	r.serve = startRcloneServe(t, filepath.Join(r.root, "data"), port,
		"--auth-key", r.cfg.AccessKey+","+r.cfg.SecretKey, "--log-level", "ERROR")
	return nil
}
