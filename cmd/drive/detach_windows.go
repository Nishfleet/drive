//go:build windows

package main

import "syscall"

// The Windows process-creation flags this file needs: a child outside this
// console (DETACHED_PROCESS) and a child in its own process group
// (CREATE_NEW_PROCESS_GROUP). syscall.SysProcAttr has no Setsid and no
// Setpgid on Windows, so both are flags here.
const (
	detachedProcess = 0x00000008
	newProcessGroup = 0x00000200
)

// detachedProcAttr starts the child outside this console and in its own
// process group (DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP), the Windows
// counterpart of a new session. syscall.SysProcAttr has no Setsid on Windows.
func detachedProcAttr() *syscall.SysProcAttr {
	return &syscall.SysProcAttr{CreationFlags: detachedProcess | newProcessGroup}
}

// ownGroupProcAttr starts the child in its own process group, so a signal sent to
// the parent's group does not reach the child. Setpgid's Windows counterpart
// is CREATE_NEW_PROCESS_GROUP.
func ownGroupProcAttr() *syscall.SysProcAttr {
	return &syscall.SysProcAttr{CreationFlags: newProcessGroup}
}
