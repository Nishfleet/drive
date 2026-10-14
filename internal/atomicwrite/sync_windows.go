//go:build windows

package atomicwrite

// FlushFileBuffers needs write access to the handle, and os.Open on a directory is read-only on Windows.
func syncDirPath(string) error {
	return nil
}
