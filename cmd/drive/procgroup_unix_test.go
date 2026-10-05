//go:build !windows

package main

import (
	"os"
	"os/exec"
	"os/signal"
	"syscall"
	"time"
)

// ownProcessGroup puts a test child in its own process group, so a signal to
// the group reaches the child and its own children.
func ownProcessGroup() *syscall.SysProcAttr {
	return &syscall.SysProcAttr{Setpgid: true}
}

// signalProcessGroup asks a child's whole process group to stop, then waits
// for the child to leave, escalating to SIGKILL after grace. Killing the group
// (a negative pid) reaches the server and anything it started, so no stand-in
// outlives the test that owns it (drive#659).
func signalProcessGroup(cmd *exec.Cmd, grace time.Duration) error {
	if cmd == nil || cmd.Process == nil {
		return nil
	}
	err := syscall.Kill(-cmd.Process.Pid, syscall.SIGTERM)
	done := make(chan struct{})
	go func() {
		_, _ = cmd.Process.Wait()
		close(done)
	}()
	select {
	case <-done:
	case <-time.After(grace):
		_ = syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL)
		<-done
	}
	return err
}

// notifyShutdown delivers the signals a stopping runner sends (SIGTERM from
// systemd or the CI runner, SIGINT from a terminal) on ch.
func notifyShutdown(ch chan<- os.Signal) {
	signal.Notify(ch, syscall.SIGINT, syscall.SIGTERM, syscall.SIGHUP)
}
