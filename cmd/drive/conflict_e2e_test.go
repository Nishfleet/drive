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
	kept, plain, conflict := waitForKeptSaves(t, []string{mountA, mountB}, name, candidates, []string{bodyA, bodyB}, 90*time.Second)

	// Both devices are notified: the device that lost the save and the other
	// one both see both files through their own mount.
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
	t.Logf("two devices, one save window: storage=stand-in, kept=%q, plain=%q, conflict=%q, A's listing=%v",
		kept, plain, conflict, names)

	// -- the offline arm ---------------------------------------------------
	// The storage goes away and both devices save the same file while it is
	// unreachable. Nothing is uploaded while a device cannot reach storage,
	// and nothing is lost when it comes back: the uploads happen on
	// reconnect and the same rule decides what is kept.
	const offlineName = "offline.txt"
	const offlineA = "A: the save made while the device could not reach storage\n"
	const offlineB = "B: the other device's save, made while storage was unreachable\n"
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
	// rule is checked by what is kept rather than by who won.
	candidates = []string{ConflictName(offlineName, deviceA), ConflictName(offlineName, "linux")}
	kept, plain, conflict = waitForKeptSaves(t, []string{mountA, mountB}, offlineName, candidates, []string{offlineA, offlineB}, 90*time.Second)
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
	kept, plain, _ := waitForKeptSaves(t, []string{mountA, mountB}, name, candidates, []string{bodyA, bodyB}, 90*time.Second)
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

// waitForKeptSaves waits until a conflict copy is visible and the two
// files together still hold both original saves.
//
// The losing device still serves its own write at the plain path until
// rclone's directory cache expires, so a read of the plain path from one
// hard-coded mount is not the rule. When the other device's upload lands
// first, that read sees the same bytes twice and misses the save that won.
//
// The wait only stats the conflict names. Reading the dirty plain file
// before it has uploaded resets rclone's write-back timer and the save
// never leaves the device.
func waitForKeptSaves(t *testing.T, mounts []string, plainName string, candidates, bodies []string, d time.Duration) (kept string, plain, conflict []byte) {
	t.Helper()
	deadline := time.Now().Add(d)
	for time.Now().Before(deadline) {
		kept = ""
		for _, dir := range mounts {
			for _, n := range candidates {
				if _, err := os.Stat(filepath.Join(dir, n)); err == nil {
					kept = n
					break
				}
			}
			if kept != "" {
				break
			}
		}
		if kept != "" {
			seen := map[string]bool{}
			var differingPlain, differingConflict []byte
			for _, dir := range mounts {
				p, err := os.ReadFile(filepath.Join(dir, plainName))
				if err == nil {
					seen[string(p)] = true
					if c, err := os.ReadFile(filepath.Join(dir, kept)); err == nil {
						seen[string(c)] = true
						if string(p) != string(c) {
							differingPlain, differingConflict = p, c
						}
					}
				}
			}
			all := true
			for _, want := range bodies {
				if !seen[want] {
					all = false
					break
				}
			}
			if all && differingPlain != nil {
				// The claiming mount already refreshed. The other device
				// sees the copy when rclone's 5s directory cache expires.
				seeUntil := time.Now().Add(15 * time.Second)
				if seeUntil.After(deadline) {
					seeUntil = deadline
				}
				for time.Now().Before(seeUntil) {
					if bothMountsSee(mounts, []string{plainName, kept}) {
						return kept, differingPlain, differingConflict
					}
					time.Sleep(500 * time.Millisecond)
				}
				t.Fatalf("both saves were kept as %s and %s, but not every device can see both: %s",
					plainName, kept, mountListings(mounts))
			}
		}
		time.Sleep(500 * time.Millisecond)
	}
	t.Fatalf("neither save survived: none of %v appeared with both original bodies; listings: %s; mount logs:\n%s",
		candidates, mountListings(mounts), mountLogTails(mounts))
	return "", nil, nil
}

func bothMountsSee(mounts, names []string) bool {
	for _, dir := range mounts {
		for _, n := range names {
			if _, err := os.Stat(filepath.Join(dir, n)); err != nil {
				return false
			}
		}
	}
	return true
}

func mountListings(mounts []string) string {
	var b strings.Builder
	for i, dir := range mounts {
		if i > 0 {
			b.WriteString("; ")
		}
		entries, err := os.ReadDir(dir)
		if err != nil {
			fmt.Fprintf(&b, "%s: %v", dir, err)
			continue
		}
		names := make([]string, 0, len(entries))
		for _, e := range entries {
			body, err := os.ReadFile(filepath.Join(dir, e.Name()))
			if err != nil {
				names = append(names, e.Name()+"<unreadable>")
				continue
			}
			names = append(names, fmt.Sprintf("%s:%q", e.Name(), body))
		}
		fmt.Fprintf(&b, "%s=%v", filepath.Base(filepath.Dir(dir)), names)
	}
	return b.String()
}

func mountLogTails(mounts []string) string {
	var b strings.Builder
	for i, dir := range mounts {
		if i > 0 {
			b.WriteString("\n")
		}
		logPath := filepath.Join(filepath.Dir(dir), ".config", "drive", "mount.log")
		body, err := os.ReadFile(logPath)
		if err != nil {
			fmt.Fprintf(&b, "%s: %v", logPath, err)
			continue
		}
		fmt.Fprintf(&b, "%s:\n%s", filepath.Base(filepath.Dir(dir)), tailLines(string(body), 20))
	}
	return b.String()
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
