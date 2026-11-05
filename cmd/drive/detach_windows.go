//go:build windows

package main

import "syscall"

func detachedProcAttr() *syscall.SysProcAttr {
	const detachedProcess, newProcessGroup = 0x00000008, 0x00000200
	return &syscall.SysProcAttr{CreationFlags: detachedProcess | newProcessGroup}
}
