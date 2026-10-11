package atomicwrite

import "testing"

// TestSyncDirPathAcceptsARealDirectory: SyncFile and SyncDir are variables
// the cmd/drive tests stand in for, so the directory half is never observed
// with its real implementation there. This one leaves every stand-in alone
// and proves the platform function this package ships fsyncs a directory
// handle the way os.Open opens one -- read-only, which is exactly the handle
// POSIX allows fsync on (sync_unix.go, drive#544). The file half is
// os.File.Sync itself, and its wiring into the write is what the stand-in
// tests observe.
func TestSyncDirPathAcceptsARealDirectory(t *testing.T) {
	dir := t.TempDir()
	if err := syncDirPath(dir); err != nil {
		t.Errorf("syncDirPath(%s) on this platform: %v", dir, err)
	}
}
