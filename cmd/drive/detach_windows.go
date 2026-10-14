//go:build windows

package main

import "syscall"

// syscall.SysProcAttr has no Setsid on Windows; DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP is the counterpart.
func detachedProcAttr() *syscall.SysProcAttr {
	const detachedProcess, newProcessGroup = 0x00000008, 0x00000200
	return &syscall.SysProcAttr{CreationFlags: detachedProcess | newProcessGroup}
}
