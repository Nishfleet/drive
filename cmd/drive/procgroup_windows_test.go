//go:build windows

package main

import (
	"os"
	"os/exec"
	"os/signal"
	"syscall"
	"time"
)

func ownProcessGroup() *syscall.SysProcAttr {
	return &syscall.SysProcAttr{CreationFlags: 0x00000200}
}

func signalProcessGroup(cmd *exec.Cmd, grace time.Duration) error {
	_ = grace
	if cmd == nil || cmd.Process == nil {
		return nil
	}
	err := cmd.Process.Kill()
	_, _ = cmd.Process.Wait()
	return err
}

func notifyShutdown(ch chan<- os.Signal) {
	signal.Notify(ch, os.Interrupt)
}
