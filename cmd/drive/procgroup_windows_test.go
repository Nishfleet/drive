//go:build windows

package main

import "syscall"

// ownProcessGroup is the Windows counterpart: CREATE_NEW_PROCESS_GROUP, since
// syscall.SysProcAttr has no Setpgid on Windows.
func ownProcessGroup() *syscall.SysProcAttr {
	return &syscall.SysProcAttr{CreationFlags: 0x00000200}
}
