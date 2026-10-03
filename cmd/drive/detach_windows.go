//go:build windows

package main

import "syscall"

// detachedProcAttr starts the child outside this console and in its own
// process group (DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP), the Windows
// counterpart of a new session. syscall.SysProcAttr has no Setsid on Windows.
func detachedProcAttr() *syscall.SysProcAttr {
	const detachedProcess, newProcessGroup = 0x00000008, 0x00000200
	return &syscall.SysProcAttr{CreationFlags: detachedProcess | newProcessGroup}
}
