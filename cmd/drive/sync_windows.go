//go:build windows

package main

// syncDirPath is the Windows half of the directory fsync (config.go
// WriteFileAtomic). FlushFileBuffers needs write access to the handle and
// os.Open on a directory is read-only here, so calling it would be a refusal
// rather than a promise. On Windows the guarantee this change delivers is the
// file fsync alone: the bytes are on the disk before the rename, which is the
// half that stops a cut from truncating credentials.json or offline.json to
// zero length. The rename metadata itself is left to NTFS, which is a
// journalled file system and replays its transaction; this is crash
// consistency for the rename, NOT the fsync-grade durability the unix half
// gives, and no code or comment here claims otherwise. The no-op keeps the
// same shape and the same error channel on both platforms (drive#544).
func syncDirPath(string) error {
	return nil
}
