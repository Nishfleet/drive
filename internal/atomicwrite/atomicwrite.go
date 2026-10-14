package atomicwrite

import (
	"fmt"
	"os"
	"path/filepath"
)

// SyncFile puts the bytes on the disk before the file is renamed into place.
var SyncFile = func(f *os.File) error { return f.Sync() }

// SyncDir puts the rename itself on the disk.
var SyncDir = func(dir string) error { return syncDirPath(dir) }

// Write writes data to path via a sibling temp file and rename.
func Write(path string, data []byte, mode os.FileMode) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return fmt.Errorf("create dir for %s: %w", path, err)
	}
	tmp, err := os.CreateTemp(filepath.Dir(path), ".drive-*")
	if err != nil {
		return fmt.Errorf("temp file for %s: %w", path, err)
	}
	tmpName := tmp.Name()
	defer os.Remove(tmpName)
	if _, err := tmp.Write(data); err != nil {
		tmp.Close()
		return fmt.Errorf("write %s: %w", path, err)
	}
	if err := SyncFile(tmp); err != nil {
		tmp.Close()
		return fmt.Errorf("save %s to the disk before renaming it into place: %w", path, err)
	}
	if err := tmp.Close(); err != nil {
		return fmt.Errorf("close %s: %w", path, err)
	}
	if err := os.Chmod(tmpName, mode); err != nil {
		return fmt.Errorf("chmod %s: %w", path, err)
	}
	if err := os.Rename(tmpName, path); err != nil {
		return fmt.Errorf("rename into place %s: %w", path, err)
	}
	if err := SyncDir(filepath.Dir(path)); err != nil {
		return fmt.Errorf("%s holds the new contents, but saving that to the disk was not confirmed: %w", path, err)
	}
	return nil
}
