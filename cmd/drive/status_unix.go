//go:build !windows

package main

import "syscall"

// cacheDiskHasNoSpace reports whether dir's filesystem has no blocks left for
// a non-root write. It is the kernel's own statfs, used when the mount is
// down so rclone vfs/stats cannot answer, and as a fallback when it can.
func cacheDiskHasNoSpace(dir string) bool {
	var st syscall.Statfs_t
	if err := syscall.Statfs(dir, &st); err != nil {
		return false
	}
	return st.Bavail == 0
}
