package main

import (
	"os"
	"path/filepath"
	"testing"
)

// uninstallHome is a home the way a mounted device looks: the key
// and config, both login items, and a drive folder holding a file.
func uninstallHome(t *testing.T) string {
	t.Helper()
	home := configWithLoginItem(t)
	prefetch := PrefetchLoginItemPath("linux", home)
	if err := os.MkdirAll(filepath.Dir(prefetch), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(prefetch, []byte("prefetch unit file"), 0o644); err != nil {
		t.Fatal(err)
	}
	driveDir := DefaultMountDir(home)
	if err := os.MkdirAll(driveDir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(driveDir, "file.txt"), []byte("the user's file"), 0o644); err != nil {
		t.Fatal(err)
	}
	return home
}

// The caller test: the flag path runUninstall owns reaches Uninstall
// with the --home it was given, and both login items — the mount item
// and the prefetch sidecar `drive mount` writes beside it — are
// removed, so nothing starts drive at the next login.
func TestUninstallRemovesBothLoginItems(t *testing.T) {
	home := uninstallHome(t)

	if err := runUninstall([]string{"--home", home}); err != nil {
		t.Fatal(err)
	}
	for _, gone := range []string{
		LoginItemPath("linux", home),
		PrefetchLoginItemPath("linux", home),
	} {
		if _, err := os.Stat(gone); !os.IsNotExist(err) {
			t.Errorf("%s still exists after uninstall", gone)
		}
	}
}

// Uninstall is not logout. The key, the config directory and the
// drive folder all survive it: the refusal to remove the drive folder
// is the point of the command, so the file inside it is read back and
// compared, not just its existence checked.
func TestUninstallKeepsTheKeyTheConfigAndTheDriveFolder(t *testing.T) {
	home := uninstallHome(t)
	file := filepath.Join(DefaultMountDir(home), "file.txt")

	if err := runUninstall([]string{"--home", home}); err != nil {
		t.Fatal(err)
	}
	for _, kept := range []string{
		RcloneConfigPath(home),
		DefaultConfigDir(home),
		DefaultMountDir(home),
	} {
		if _, err := os.Stat(kept); err != nil {
			t.Errorf("%s did not survive uninstall: %v", kept, err)
		}
	}
	data, err := os.ReadFile(file)
	if err != nil {
		t.Fatalf("the drive folder's file did not survive uninstall: %v", err)
	}
	if string(data) != "the user's file" {
		t.Errorf("the drive folder's file changed: %q", data)
	}
}

// A machine that was never mounted, or an uninstall that already ran,
// has no login item and no mount: both are the same success, the way
// logout is safe to run twice.
func TestUninstallIsSafeToRunTwice(t *testing.T) {
	home := uninstallHome(t)
	if err := runUninstall([]string{"--home", home}); err != nil {
		t.Fatal(err)
	}
	if err := runUninstall([]string{"--home", home}); err != nil {
		t.Fatalf("second uninstall: %v", err)
	}
}

// The home flag is the one thing the caller parses: an argument that
// is not a flag is refused, the way every other subcommand refuses.
func TestUninstallRefusesAnUnexpectedArgument(t *testing.T) {
	if err := runUninstall([]string{"--home", t.TempDir(), "extra"}); err == nil {
		t.Fatal("an unexpected argument was accepted")
	}
}
