//go:build !windows

package atomicwrite

import "os"

// syncDirPath fsyncs a directory so the rename that put a file in it reaches
// the disk (atomicwrite.go). POSIX allows it on a read-only handle,
// which is what os.Open gives.
func syncDirPath(dir string) error {
	d, err := os.Open(dir)
	if err != nil {
		return err
	}
	defer d.Close()
	return d.Sync()
}
