//go:build windows

package main

// cacheDiskHasNoSpace is the kernel fallback for a full VFS cache disk.
// On Windows the mounted rclone's vfs/stats diskCache.outOfSpace is the
// answer (cacheIsFull); there is no second detector here.
func cacheDiskHasNoSpace(string) bool {
	return false
}
