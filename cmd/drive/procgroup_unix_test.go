//go:build !windows

package main

import "syscall"

// ownProcessGroup puts a test child in its own process group, so a signal to
// the group reaches the child and its own children.
func ownProcessGroup() *syscall.SysProcAttr {
	return &syscall.SysProcAttr{Setpgid: true}
}
