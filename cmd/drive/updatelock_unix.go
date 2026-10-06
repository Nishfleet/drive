//go:build unix

package main

import (
	"os"
	"syscall"
)

// flock takes an exclusive, non-blocking advisory lock on an open file, the
// way `drive status`'s once-a-day update notice serialises its state read and
// write. Non-blocking: a second status run that arrives while the first is
// still asking the package manager gives up instead of waiting, because the
// notice is throughput and the first run's write quiets it anyway.
func flock(f *os.File) error {
	return syscall.Flock(int(f.Fd()), syscall.LOCK_EX|syscall.LOCK_NB)
}

// flockEnd releases the lock; the close that follows also does, and is
// enough on its own, but an explicit unlock keeps the pair readable.
func flockEnd(f *os.File) {
	_ = syscall.Flock(int(f.Fd()), syscall.LOCK_UN)
}
