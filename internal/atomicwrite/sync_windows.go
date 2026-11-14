//go:build windows

package atomicwrite

// upstream: https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-flushfilebuffers — FlushFileBuffers needs write access to the handle, and os.Open on a directory is read-only on Windows.
func syncDirPath(string) error {
	return nil
}
