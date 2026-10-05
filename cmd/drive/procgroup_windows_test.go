//go:build windows

package main

import (
	"os"
	"os/exec"
	"os/signal"
	"syscall"
	"time"
)

// ownProcessGroup is the Windows counterpart: CREATE_NEW_PROCESS_GROUP, since
// syscall.SysProcAttr has no Setpgid on Windows.
func ownProcessGroup() *syscall.SysProcAttr {
	return &syscall.SysProcAttr{CreationFlags: 0x00000200}
}

// signalProcessGroup stops the child and waits for it, the Windows half of the
// unix group kill: CREATE_NEW_PROCESS_GROUP has no single group signal, so the
// child itself is killed (drive#659).
func signalProcessGroup(cmd *exec.Cmd, grace time.Duration) error {
	_ = grace
	if cmd == nil || cmd.Process == nil {
		return nil
	}
	err := cmd.Process.Kill()
	_, _ = cmd.Process.Wait()
	return err
}

// notifyShutdown delivers the signal a stopping runner sends on ch. Windows
// has no SIGTERM, so only the interrupt is watched.
func notifyShutdown(ch chan<- os.Signal) {
	signal.Notify(ch, os.Interrupt)
}
