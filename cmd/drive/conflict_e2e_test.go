package main

import (
	"context"
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
	t.Cleanup(func() {
		if !t.Failed() {
			return
		}
		for _, h := range []string{homeA, homeB} {
			if log, err := os.ReadFile(filepath.Join(h, ".config", "drive", "mount.log")); err == nil {
				t.Logf("%s mount log:\n%s", filepath.Base(h), tailLines(string(log), 60))
			}
		}
	})
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
	if err := os.WriteFile(filepath.Join(mountB, name), []byte(bodyB), 0o644); err != nil {
		t.Fatal(err)
	}

	// The rule is decided after the uploads have landed. Write-back timers
	// and rclone's retry delay after a dead stand-in can spread the two
	// uploads past the guard's 10s win watch (merge-group runs 37505697801,
	// 37519236130), so the queues are released together first. Storage is
	// the truth for the bytes: a mount still holding the save that lost
	// reads as if both files were the winner (merge-group run 37516493629).
	candidates := []string{ConflictName(name, deviceA), ConflictName(name, "linux")}
	rcAClient := rcClientForTestHome(t, homeA, rcA, RemoteFor(cfg))
	rcBClient := rcClientForTestHome(t, homeB, rcB, RemoteFor(cfg))
	releaseSavesTogether(t, rcAClient, rcBClient, name)
	kept := proveBothSavesKept(t, root, cfg, rcAClient, rcBClient, mountA, mountB, name, bodyA, bodyB, candidates)

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
		name, kept, names)

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
	if err := os.WriteFile(filepath.Join(mountB, offlineName), []byte(offlineB), 0o644); err != nil {
		t.Fatalf("save on device B while offline: %v", err)
	}
	if err := restart.start(t); err != nil {
		t.Fatal(err)
	}

	// Whichever save lands last is the plain file; the other is the conflict
	// copy, named for the device that lost it. Either device can lose, so the
	// rule is checked by what is kept rather than by who won. The stand-in
	// coming back can leave rclone's queue on a minutes-long retry delay
	// (rc.go: rclone retries forever with a 5-minute backoff), which is
	// longer than this proof's wait — resume's own ReleaseQueuedUploads is
	// what makes both uploads eligible in one window again.
	candidates = []string{ConflictName(offlineName, deviceA), ConflictName(offlineName, "linux")}
	releaseSavesTogether(t, rcAClient, rcBClient, offlineName)
	kept = proveBothSavesKept(t, root, cfg, rcAClient, rcBClient, mountA, mountB, offlineName, offlineA, offlineB, candidates)
	plain, err := os.ReadFile(standinObjectPath(root, cfg, offlineName))
	if err != nil {
		t.Fatal(err)
	}
	conflict, err := os.ReadFile(standinObjectPath(root, cfg, kept))
	if err != nil {
		t.Fatal(err)
	}
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
	var kept string
	deadline := time.Now().Add(90 * time.Second)
	for time.Now().Before(deadline) {
		for _, n := range candidates {
			if _, err := os.Stat(filepath.Join(mountA, n)); err == nil {
				kept = n
				break
			}
		}
		if kept != "" {
			break
		}
		time.Sleep(500 * time.Millisecond)
	}
	if kept == "" {
		t.Fatalf("one save was lost: neither %v appeared on device A", candidates)
	}
	plain, err := os.ReadFile(filepath.Join(mountA, name))
	if err != nil {
		t.Fatal(err)
	}
	conflict, err := os.ReadFile(filepath.Join(mountA, kept))
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{bodyA, bodyB} {
		if string(plain) != want && string(conflict) != want {
			t.Errorf("the save %q survived nowhere: plain=%q conflict=%q", want, plain, conflict)
		}
	}
	if string(plain) == string(conflict) {
		t.Errorf("both saves are the same bytes (%q): one device's save was overwritten", plain)
	}
	// Both devices see both files that survived: the plain file and the one
	// conflict copy — named for whichever device lost. There is never one per
	// device; the two machines agreed on what to keep only by what landed on
	// top, which is exactly what cannot be faked by two directories.
	for _, m := range []struct{ label, dir string }{{"A", mountA}, {"B", mountB}} {
		for _, n := range []string{name, kept} {
			if _, err := os.Stat(filepath.Join(m.dir, n)); err != nil {
				t.Errorf("device %s cannot see %s: %v", m.label, n, err)
			}
		}
	}
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

// standinObjectPath is the object on disk inside the loopback S3 stand-in.
// It is the same join transferEnv.objectPath uses, so a proof that both
// saves survived reads storage rather than a mount's dirty file.
func standinObjectPath(root string, cfg StorageConfig, name string) string {
	return filepath.Join(root, "data", cfg.Bucket, filepath.FromSlash(cfg.Prefix), name)
}

func queueHasName(q Queue, name string) bool {
	for _, item := range q.Queue {
		if item.Name == name || strings.HasSuffix(item.Name, "/"+name) {
			return true
		}
	}
	return false
}

// releaseSavesTogether waits until both devices have name in rclone's
// upload queue, then uses resume's own ReleaseQueuedUploads so the two
// saves land in one window. Write-back is 5s; after a dead stand-in the
// queue can sit on a 5-minute retry delay, which is past the conflict
// guard's 10s win watch.
func releaseSavesTogether(t *testing.T, a, b *rcClient, name string) {
	t.Helper()
	deadline := time.Now().Add(20 * time.Second)
	seenBoth := false
	var lastA, lastB error
	for time.Now().Before(deadline) {
		qa, errA := a.ReadQueue(context.Background())
		qb, errB := b.ReadQueue(context.Background())
		lastA, lastB = errA, errB
		if errA != nil || errB != nil {
			time.Sleep(100 * time.Millisecond)
			continue
		}
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		if queueHasName(qa, name) {
			if err := a.HoldQueuedUploads(ctx); err != nil {
				cancel()
				t.Fatalf("device A hold uploads of %s: %v", name, err)
			}
		}
		if queueHasName(qb, name) {
			if err := b.HoldQueuedUploads(ctx); err != nil {
				cancel()
				t.Fatalf("device B hold uploads of %s: %v", name, err)
			}
		}
		cancel()
		if queueHasName(qa, name) && queueHasName(qb, name) {
			seenBoth = true
			break
		}
		time.Sleep(100 * time.Millisecond)
	}
	if !seenBoth {
		t.Fatalf("both devices did not queue %s within 20s (A queue err=%v, B queue err=%v)", name, lastA, lastB)
	}
	// The conflict guard hashes a save while it is still in the queue
	// (conflict_guard.go sight). Releasing in the same instant the
	// items appear lets a tiny file leave before the next 500ms pass,
	// and then nothing writes a conflict copy.
	time.Sleep(2 * conflictInterval)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if err := a.ReleaseQueuedUploads(ctx); err != nil {
		t.Fatalf("device A release uploads of %s: %v", name, err)
	}
	if err := b.ReleaseQueuedUploads(ctx); err != nil {
		t.Fatalf("device B release uploads of %s: %v", name, err)
	}
}

func logStandinListing(t *testing.T, root string, cfg StorageConfig) {
	t.Helper()
	dir := filepath.Join(root, "data", cfg.Bucket, filepath.FromSlash(cfg.Prefix))
	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Logf("stand-in %s: %v", dir, err)
		return
	}
	var names []string
	for _, e := range entries {
		names = append(names, e.Name())
	}
	t.Logf("stand-in listing %s: %v", dir, names)
}

// proveBothSavesKept waits until storage holds a conflict copy of name,
// checks both bodies survived there, then refreshes both mounts so each
// device can see both files. It reads the stand-in, not the mount: the
// device that lost still shows its own save at the plain path until the
// directory cache expires.
func proveBothSavesKept(t *testing.T, root string, cfg StorageConfig, rcA, rcB *rcClient, mountA, mountB, name, bodyA, bodyB string, candidates []string) string {
	t.Helper()
	var kept string
	deadline := time.Now().Add(90 * time.Second)
	for time.Now().Before(deadline) {
		for _, n := range candidates {
			if _, err := os.Stat(standinObjectPath(root, cfg, n)); err == nil {
				kept = n
				break
			}
		}
		if kept != "" {
			break
		}
		time.Sleep(500 * time.Millisecond)
	}
	if kept == "" {
		logStandinListing(t, root, cfg)
		qa, errA := rcA.ReadQueue(context.Background())
		qb, errB := rcB.ReadQueue(context.Background())
		t.Logf("device A queue (err=%v): %+v", errA, qa.Queue)
		t.Logf("device B queue (err=%v): %+v", errB, qb.Queue)
		t.Fatalf("neither save survived: none of %v appeared in stand-in storage", candidates)
	}

	plain, err := os.ReadFile(standinObjectPath(root, cfg, name))
	if err != nil {
		t.Fatal(err)
	}
	conflict, err := os.ReadFile(standinObjectPath(root, cfg, kept))
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{bodyA, bodyB} {
		if string(plain) != want && string(conflict) != want {
			t.Errorf("the save %q survived nowhere: plain=%q conflict=%q", want, plain, conflict)
		}
	}
	if string(plain) == string(conflict) {
		t.Errorf("both saves are the same bytes (%q): the other device's save was overwritten", plain)
	}

	for _, m := range []struct {
		label, dir string
		rc         *rcClient
	}{{"A", mountA, rcA}, {"B", mountB, rcB}} {
		waitMountSees(t, m.rc, m.dir, []string{name, kept})
		got, err := os.ReadFile(filepath.Join(m.dir, kept))
		if err != nil {
			t.Fatalf("device %s cannot read the conflict copy: %v", m.label, err)
		}
		if string(got) != string(conflict) {
			t.Errorf("the conflict copy on device %s is %q, want %q", m.label, got, conflict)
		}
	}
	return kept
}

func waitMountSees(t *testing.T, c *rcClient, dir string, names []string) {
	t.Helper()
	deadline := time.Now().Add(20 * time.Second)
	var last error
	for time.Now().Before(deadline) {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		err := c.refresh(ctx, false)
		cancel()
		if err != nil {
			last = err
			time.Sleep(500 * time.Millisecond)
			continue
		}
		missing := false
		for _, n := range names {
			if _, err := os.Stat(filepath.Join(dir, n)); err != nil {
				last = err
				missing = true
				break
			}
		}
		if !missing {
			return
		}
		time.Sleep(500 * time.Millisecond)
	}
	t.Fatalf("mount %s did not show %v: %v", dir, names, last)
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
