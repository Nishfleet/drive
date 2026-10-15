package atomicwrite

import "testing"

func TestSyncDirPathAcceptsARealDirectory(t *testing.T) {
	dir := t.TempDir()
	if err := syncDirPath(dir); err != nil {
		t.Errorf("syncDirPath(%s) on this platform: %v", dir, err)
	}
}
