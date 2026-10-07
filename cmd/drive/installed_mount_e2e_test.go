package main

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// TestTwoDevicesKeepBothSavesThroughTheInstalledUnit is issue #515: `drive
// init` writes a login item that runs the product, two devices that start
// from that item keep both saves as a conflict copy, and a pinned file stays
// in the cache after storage goes away.
func TestTwoDevicesKeepBothSavesThroughTheInstalledUnit(t *testing.T) {
	if testing.Short() {
		t.Skip("stand-in proof skipped in -short mode")
	}
	if CurrentGOOS() == "windows" {
		t.Skip("the installed-unit proof on Windows is the login-task job")
	}

	bin := driveBin(t)
	origLookup := lookupDriveBin
	lookupDriveBin = func() (string, error) { return bin, nil }
	t.Cleanup(func() { lookupDriveBin = origLookup })

	var mounts []*exec.Cmd
	origStart := startLoginItem
	startLoginItem = func(goos string, p MountPlan, itemPath string) error {
		cmd := exec.Command(p.DriveBin, p.productArgs()...)
		cmd.Env = append(envWithoutDriveS3(os.Environ()), "DRIVE_PREFETCH=0")
		cmd.Stdout, cmd.Stderr = os.Stdout, os.Stderr
		if err := cmd.Start(); err != nil {
			return err
		}
		mounts = append(mounts, cmd)
		return nil
	}
	t.Cleanup(func() { startLoginItem = origStart })

	root := t.TempDir()
	cfg, standin := standinOn(t, root, "u/installed")
	restart := &standinRestart{serve: standin, root: root, cfg: cfg}

	homeA := filepath.Join(root, "home-a")
	homeB := filepath.Join(root, "home-b")
	mountA := filepath.Join(homeA, "Drive")
	mountB := filepath.Join(homeB, "Drive")
	rcA, rcB := "127.0.0.1:"+freePort(t), "127.0.0.1:"+freePort(t)

	t.Setenv("DRIVE_S3_ACCESS_KEY_ID", cfg.AccessKey)
	t.Setenv("DRIVE_S3_SECRET_ACCESS_KEY", cfg.SecretKey)
	t.Setenv("DRIVE_S3_ENDPOINT", cfg.Endpoint)
	t.Setenv("DRIVE_S3_BUCKET", cfg.Bucket)
	t.Setenv("DRIVE_S3_PREFIX", cfg.Prefix)
	t.Setenv("DRIVE_API_URL", "")
	for _, home := range []string{homeA, homeB} {
		if err := SaveCredentials(home, Credentials{
			Endpoint:    cfg.Endpoint,
			Bucket:      cfg.Bucket,
			Prefix:      cfg.Prefix,
			Region:      "us-east-1",
			AccessKeyID: cfg.AccessKey,
		}); err != nil {
			t.Fatal(err)
		}
	}

	initOne := func(home, device, rcAddr string) {
		t.Helper()
		if err := runInit([]string{
			"--home", home,
			"--endpoint", cfg.Endpoint,
			"--bucket", cfg.Bucket,
			"--prefix", cfg.Prefix,
			"--device", device,
			"--rc-addr", rcAddr,
		}); err != nil {
			t.Fatalf("drive init --home %s: %v", home, err)
		}
	}
	initOne(homeA, "mac", rcA)
	initOne(homeB, "linux", rcB)
	if len(mounts) != 2 {
		t.Fatalf("init started %d mounts, want 2", len(mounts))
	}
	t.Cleanup(func() {
		for i, home := range []string{homeA, homeB} {
			if i < len(mounts) {
				stopStandinProcess(mounts[i], filepath.Join(home, "Drive"))
			}
		}
	})

	for _, tc := range []struct{ home, device string }{{homeA, "mac"}, {homeB, "linux"}} {
		item, err := os.ReadFile(LoginItemPath(CurrentGOOS(), tc.home))
		if err != nil {
			t.Fatalf("read the unit drive init wrote for %s: %v", tc.device, err)
		}
		body := string(item)
		if !strings.Contains(body, bin) || !strings.Contains(body, "--foreground") || !strings.Contains(body, tc.home) {
			t.Fatalf("the unit drive init wrote for %s does not run the product:\n%s", tc.device, body)
		}
		if strings.Contains(body, "rclone mount") || strings.Contains(body, "nfsmount") {
			t.Fatalf("the unit drive init wrote for %s still execs rclone:\n%s", tc.device, body)
		}
	}

	for i, dir := range []string{mountA, mountB} {
		if !waitForMount(t, mounts[i], dir) {
			t.Skipf("this host will not bring up the installed-unit mount on %s (%s)", dir, mountSkipReason())
		}
	}

	const name = "report.txt"
	const bodyA = "A: this save was made first, on the device named mac\n"
	const bodyB = "B: this save was made second, on the device named linux\n"
	if err := os.WriteFile(filepath.Join(mountA, name), []byte(bodyA), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(mountB, name), []byte(bodyB), 0o644); err != nil {
		t.Fatal(err)
	}
	deadline := time.Now().Add(90 * time.Second)
	conflict := ConflictName(name, "mac")
	for time.Now().Before(deadline) {
		_, errA := os.Stat(filepath.Join(mountA, conflict))
		_, errB := os.Stat(filepath.Join(mountB, conflict))
		if errA == nil && errB == nil {
			break
		}
		time.Sleep(500 * time.Millisecond)
	}
	if _, err := os.Stat(filepath.Join(mountA, conflict)); err != nil {
		t.Fatalf("neither save survived: %s never appeared on device A", conflict)
	}
	gotB, err := os.ReadFile(filepath.Join(mountB, name))
	if err != nil {
		t.Fatal(err)
	}
	if string(gotB) != bodyB {
		t.Errorf("the plain file is %q, want the save that landed later (%q)", gotB, bodyB)
	}
	for _, dir := range []string{mountA, mountB} {
		got, err := os.ReadFile(filepath.Join(dir, conflict))
		if err != nil {
			t.Fatalf("conflict copy missing on %s: %v", dir, err)
		}
		if string(got) != bodyA {
			t.Errorf("conflict copy on %s is %q, want the earlier save", dir, got)
		}
	}

	pin := filepath.Join(mountA, "pinned.txt")
	if err := os.WriteFile(pin, []byte("kept offline through the installed unit\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if _, err := os.ReadFile(pin); err != nil {
		t.Fatal(err)
	}
	out := runDriveHome(t, rcA, "offline", "--home", homeA, "pinned.txt")
	if !strings.Contains(out, "kept offline:") || !strings.Contains(out, "pinned.txt") {
		t.Fatalf("drive offline said %q", out)
	}
	if err := restart.stop(); err != nil {
		t.Fatal(err)
	}
	got, err := readWithTimeout(pin, 8*time.Second)
	if err != nil {
		t.Fatalf("pinned file was not cached after storage went away: %v", err)
	}
	if string(got) != "kept offline through the installed unit\n" {
		t.Errorf("pinned file = %q", got)
	}
	t.Logf("installed unit: conflict=%s, pinned file stayed cached after storage stopped", conflict)
}

// envWithoutDriveS3 drops the storage keys a real login item does not
// inherit: systemd and launchd start the product with rclone.env, not
// DRIVE_S3_* from the parent shell (drive#515).
func envWithoutDriveS3(env []string) []string {
	out := make([]string, 0, len(env))
	for _, e := range env {
		if strings.HasPrefix(e, "DRIVE_S3_") {
			continue
		}
		out = append(out, e)
	}
	return out
}
