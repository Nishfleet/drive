//go:build !windows

package main

import "syscall"

func cacheDiskHasNoSpace(dir string) bool {
	var st syscall.Statfs_t
	if err := syscall.Statfs(dir, &st); err != nil {
		return false
	}
	return st.Bavail == 0
}
