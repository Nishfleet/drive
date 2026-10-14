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

func TestTwoDevicesKeepBothSaves(t *testing.T) {
	if testing.Short() {
		t.Skip("stand-in proof skipped in -short mode")
	}
	root := t.TempDir()
	cfg, standin := standinOn(t, root, "u/conflict")
	restart := &standinRestart{serve: standin, root: root, cfg: cfg}
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

	if err := os.WriteFile(filepath.Join(mountA, name), []byte(bodyA), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(mountB, name), []byte(bodyB), 0o644); err != nil {
		t.Fatal(err)
	}

	candidates := []string{ConflictName(name, deviceA), ConflictName(name, "linux")}
	rcAClient := rcClientForTestHome(t, homeA, rcA, RemoteFor(cfg))
	rcBClient := rcClientForTestHome(t, homeB, rcB, RemoteFor(cfg))
	releaseSavesTogether(t, rcAClient, rcBClient, name)
	kept := proveBothSavesKept(t, root, cfg, rcAClient, rcBClient, mountA, mountB, name, bodyA, bodyB, candidates)

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
		if log, err := os.ReadFile(filepath.Join(home, ".config", "drive", "mount.log")); err == nil {
			t.Logf("device %s mount log:\n%s", device, tailLines(string(log), 6))
		}
		skipNoMount(t, "this host will not bring up the %s mount (%s)", device, mountSkipReason())
	}
	return func() { stopStandinProcess(cmd, mountDir) }
}

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
	time.Sleep(2 * time.Second)
	if err := os.WriteFile(filepath.Join(mountB, name), []byte(bodyB), 0o644); err != nil {
		t.Fatal(err)
	}

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

func tailLines(s string, n int) string {
	lines := strings.Split(strings.TrimRight(s, "\n"), "\n")
	if len(lines) > n {
		lines = lines[len(lines)-n:]
	}
	return strings.Join(lines, "\n")
}

type standinRestart struct {
	serve *exec.Cmd
	root  string
	cfg   StorageConfig
}

func (r *standinRestart) stop() error {
	if err := stopProcess(r.serve); err != nil {
		return fmt.Errorf("take the storage away: %w", err)
	}
	return nil
}

func (r *standinRestart) start(t *testing.T) error {
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
