package main

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// TestStandinOfflineProof is the drive issue #115 finish line, against a
// local `rclone serve s3` stand-in. It keeps a folder offline with the real
// command, cuts the network, opens and edits a file, restores the network,
// and checks the edit arrives with a matching checksum. A new file written
// into that folder is kept offline too.
func TestStandinOfflineProof(t *testing.T) {
	if testing.Short() {
		t.Skip("stand-in proof skipped in -short mode")
	}
	env := newTransferEnv(t)
	seedEnv := standinEnv(t, env.home, env.cfg)
	seedStandin(t, env.root, env.cfg, seedEnv, "keep/note.txt", 4<<10)
	seedStandin(t, env.root, env.cfg, seedEnv, "keep/nested/more.txt", 2<<10)

	env.startMount()
	out := runDriveHome(t, env.rcAddr, "offline", "--home", env.home, "keep")
	if !strings.Contains(out, "kept offline: keep") {
		t.Fatalf("drive offline said %q", out)
	}

	if err := env.restart.stop(); err != nil {
		t.Fatal(err)
	}
	note := filepath.Join(env.mountDir, "keep", "note.txt")
	got, err := readWithTimeout(note, 8*time.Second)
	if err != nil {
		t.Fatalf("open a kept-offline file with no network: %v", err)
	}
	if len(got) != 4<<10 {
		t.Fatalf("kept file is %d bytes, want %d: the copy was not whole", len(got), 4<<10)
	}
	edit := []byte("edited while the device could not reach storage\n")
	if err := os.WriteFile(note, edit, 0o644); err != nil {
		t.Fatalf("save while offline: %v", err)
	}
	wantSum, err := md5File(note)
	if err != nil {
		t.Fatal(err)
	}

	if err := env.restart.start(t); err != nil {
		t.Fatal(err)
	}
	object := env.objectPath("keep/note.txt")
	if err := waitForFile(t, object, int64(len(edit)), 45*time.Second); err != nil {
		t.Fatalf("the offline edit did not arrive after the network came back: %v", err)
	}
	gotSum, err := md5File(object)
	if err != nil {
		t.Fatal(err)
	}
	if gotSum != wantSum {
		t.Errorf("checksum after reconnect: got %s want %s", gotSum, wantSum)
	}

	newName := filepath.Join(env.mountDir, "keep", "new.txt")
	if err := os.WriteFile(newName, []byte("new in a kept folder\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	time.Sleep(8 * time.Second)
	out = runDriveHome(t, env.rcAddr, "offline", "--home", env.home, "keep")
	if !strings.Contains(out, "keep") {
		t.Fatalf("re-keep after a new file: %q", out)
	}
	if err := env.restart.stop(); err != nil {
		t.Fatal(err)
	}
	got, err = readWithTimeout(newName, 8*time.Second)
	if err != nil {
		t.Fatalf("a new file inside a kept-offline folder was not kept: %v", err)
	}
	if string(got) != "new in a kept folder\n" {
		t.Errorf("new file = %q", got)
	}
}

// TestOfflineKeptFilesSurviveAFullCache proves the eviction half of #115 on
// stock rclone: a kept-offline file is re-read so rclone's own last-access
// order drops everything else when `--vfs-cache-max-size` is exceeded. The
// product mount's cap is 20G and is not overridable (TestVFSArgsPinsTheSafetyFlags);
// this proof uses rclone's own flag at 2M so the fill can actually cross it.
func TestOfflineKeptFilesSurviveAFullCache(t *testing.T) {
	if testing.Short() {
		t.Skip("stand-in proof skipped in -short mode")
	}
	if _, err := exec.LookPath("rclone"); err != nil {
		t.Skip("rclone is not installed")
	}
	root := t.TempDir()
	home := filepath.Join(root, "home")
	mountDir := filepath.Join(root, "mnt")
	cacheDir := filepath.Join(root, "cache")
	for _, d := range []string{filepath.Join(root, "data", "bucket"), home, mountDir, cacheDir} {
		if err := os.MkdirAll(d, 0o755); err != nil {
			t.Fatal(err)
		}
	}
	cfg, serve := standinOn(t, root, "u/offline-cap")
	restart := &standinRestart{serve: serve, root: root, cfg: cfg}
	seedEnv := standinEnv(t, home, cfg)
	seedStandin(t, root, cfg, seedEnv, "keep.bin", 512<<10)
	for i := 1; i <= 4; i++ {
		seedStandin(t, root, cfg, seedEnv, "other"+string(rune('0'+i))+".bin", 1<<20)
	}

	rcAddr := "127.0.0.1:" + freePort(t)
	cmd := exec.Command("rclone", "mount", RemoteFor(cfg), mountDir,
		"--config", RcloneConfigPath(home),
		"--vfs-cache-mode", "full",
		"--vfs-cache-max-size", "2M",
		"--vfs-cache-poll-interval", "1s",
		"--vfs-cache-max-age", "24h",
		"--dir-cache-time", "5s",
		"--cache-dir", cacheDir,
		"--rc", "--rc-addr", rcAddr, "--rc-no-auth")
	cmd.Stdout, cmd.Stderr = os.Stdout, os.Stderr
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	defer stopStandinProcess(cmd, mountDir)
	if !waitForMount(t, cmd, mountDir) {
		t.Skipf("this host will not bring up the mount on %s (%s)", mountDir, mountSkipReason())
	}

	if _, err := KeepOffline(mountDir, "keep.bin"); err != nil {
		t.Fatalf("keep offline: %v", err)
	}
	for i := 1; i <= 4; i++ {
		p := filepath.Join(mountDir, "other"+string(rune('0'+i))+".bin")
		if _, err := fillReadFile(p); err != nil {
			t.Fatalf("fill cache with %s: %v", p, err)
		}
	}
	targets := fillTargets{root: mountDir, offline: []string{"keep.bin"}}
	deadline := time.Now().Add(12 * time.Second)
	for time.Now().Before(deadline) {
		if _, err := targets.read(false, 0); err != nil {
			t.Fatalf("keep-warm: %v", err)
		}
		time.Sleep(500 * time.Millisecond)
	}

	if err := restart.stop(); err != nil {
		t.Fatal(err)
	}
	got, err := readWithTimeout(filepath.Join(mountDir, "keep.bin"), 8*time.Second)
	if err != nil {
		t.Fatalf("kept-offline file was dropped when the cache filled: %v", err)
	}
	if len(got) != 512<<10 {
		t.Fatalf("kept file is %d bytes after a full cache, want %d", len(got), 512<<10)
	}
}

func runDriveHome(t *testing.T, rcAddr string, args ...string) string {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 45*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, driveBin(t), args...)
	cmd.Env = append(os.Environ(), "DRIVE_RC_ADDR="+rcAddr, "DRIVE_PREFETCH=0")
	cmd.SysProcAttr = ownProcessGroup()
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("drive %s: %v\n%s", strings.Join(args, " "), err, out)
	}
	return string(out)
}

func readWithTimeout(path string, d time.Duration) ([]byte, error) {
	type result struct {
		b   []byte
		err error
	}
	ch := make(chan result, 1)
	go func() {
		b, err := os.ReadFile(path)
		ch <- result{b, err}
	}()
	select {
	case r := <-ch:
		return r.b, r.err
	case <-time.After(d):
		return nil, os.ErrDeadlineExceeded
	}
}
