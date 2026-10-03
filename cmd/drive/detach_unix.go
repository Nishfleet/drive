//go:build !windows

package main

import "syscall"

// detachedProcAttr starts the child in its own session, so it outlives the
// command that started it.
func detachedProcAttr() *syscall.SysProcAttr {
	return &syscall.SysProcAttr{Setsid: true}
}
