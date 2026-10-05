//go:build windows

package main

import (
	"errors"
	"os"
)

// flock takes an exclusive, non-blocking lock on an open file. Windows has no
// flock(2); LockFileEx needs an overlapped offset and a whole-window call, and
// the once-a-day notice it guards prints one extra line at worst when two
// `drive status` runs collide. Returning the error is the quiet miss the
// caller already handles.
func flock(*os.File) error { return errors.New("no flock(2) on Windows") }

// flockEnd releases a lock this platform never took.
func flockEnd(*os.File) {}
