//go:build windows

package main

// syncDirPath is the Windows half of the directory fsync (config.go
// WriteFileAtomic). FlushFileBuffers needs write access to the handle and
// os.Open on a directory is read-only here, so the call would be a refusal
// rather than a promise. NTFS is a journalled file system and it commits the
// rename with the rest of its transaction, so the file fsync above is the half
// that matters on this platform and the directory's is a no-op that keeps the
// same shape on both (drive#544).
func syncDirPath(string) error {
	return nil
}
