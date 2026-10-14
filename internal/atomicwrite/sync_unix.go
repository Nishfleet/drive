//go:build !windows

package atomicwrite

import "os"

// POSIX allows fsync on a read-only directory handle, which is what os.Open gives.
func syncDirPath(dir string) error {
	d, err := os.Open(dir)
	if err != nil {
		return err
	}
	defer d.Close()
	return d.Sync()
}
