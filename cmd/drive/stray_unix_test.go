//go:build !windows

package main

import (
	"os"
	"path/filepath"
	"syscall"
	"testing"
)

// TestRestoreStrayMountFilesLeavesNoPartialCopy proves a copy that fails
// part-way into the drive leaves no truncated file there to upload, and the
// whole file stays in the holding folder for the next restore.
func TestRestoreStrayMountFilesLeavesNoPartialCopy(t *testing.T) {
	dir := t.TempDir()
	mount := filepath.Join(dir, "Drive")
	holding := filepath.Join(dir, "Drive.drive-local-1")
	if err := os.MkdirAll(filepath.Join(holding, "photos"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(mount, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(holding, "photos", "a.jpg"), []byte("jpg"), 0o644); err != nil {
		t.Fatal(err)
	}
	// A fifo is a file kind the copy refuses, so it fails after the
	// folder and its first file are already in the drive.
	if err := syscall.Mkfifo(filepath.Join(holding, "photos", "b.pipe"), 0o644); err != nil {
		t.Skipf("mkfifo: %v", err)
	}
	orig := renameFile
	renameFile = func(from, to string) error {
		return &os.LinkError{Op: "rename", Old: from, New: to, Err: syscall.EXDEV}
	}
	t.Cleanup(func() { renameFile = orig })
	if err := restoreStrayMountFiles(holding, mount); err == nil {
		t.Fatal("a failed copy returned no error")
	}
	if _, err := os.Lstat(filepath.Join(mount, "photos")); !os.IsNotExist(err) {
		t.Errorf("a partial copy is left in the drive: %v", err)
	}
	if got, err := os.ReadFile(filepath.Join(holding, "photos", "a.jpg")); err != nil || string(got) != "jpg" {
		t.Errorf("holding copy = %q, %v, want it kept", got, err)
	}
}
