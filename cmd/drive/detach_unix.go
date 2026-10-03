//go:build !windows

package main

import "syscall"

// detachedProcAttr starts the child in its own session, so it outlives the
// command that started it.
func detachedProcAttr() *syscall.SysProcAttr {
	return &syscall.SysProcAttr{Setsid: true}
}

// ownGroupProcAttr starts the child in its own process group, so a signal that
// reaches the group does not reach this process. Windows has no Setpgid; its
// counterpart is CREATE_NEW_PROCESS_GROUP (detach_windows.go).
func ownGroupProcAttr() *syscall.SysProcAttr {
	return &syscall.SysProcAttr{Setpgid: true}
}
