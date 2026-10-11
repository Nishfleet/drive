package atomicwrite

import (
	"fmt"
	"os"
	"path/filepath"
)

// SyncFile puts the bytes on the disk before the file is renamed into
// place. It is a variable so a test can observe the call that a power-cut
// proof rests on: the rename is a directory operation, so without this the
// machine can lose a write the file system already answered "done" to, and
// the cut leaves a zero-length credentials.json or offline.json (drive#544).
var SyncFile = func(f *os.File) error { return f.Sync() }

// SyncDir puts the rename itself on the disk. A new name reaching the disk is
// a separate step from the bytes reaching it, so the directory is synced after
// the rename or the file can come back as it was before the write: for
// credentials.json that is "nothing was ever written" (drive#544). The
// platform owns the implementation, because a read-only handle is what Windows
// gives a directory (sync_unix.go, sync_windows.go).
var SyncDir = func(dir string) error { return syncDirPath(dir) }

// Write writes data to path via a sibling temp file and rename.
// Secret-bearing files pass mode 0600. The temp file is synced before it is
// closed and the directory is synced after the rename, because a rename is
// not a promise that the bytes survived the machine losing power (drive#544).
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
		// The bytes are in place and were synced above, so this is a
		// durability the machine did not confirm, not a write that failed. The
		// error still surfaces, because a caller that was told nothing would
		// report a success nobody proved.
		return fmt.Errorf("%s holds the new contents, but saving that to the disk was not confirmed: %w", path, err)
	}
	return nil
}
