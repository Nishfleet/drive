//go:build !unix && !windows

package main

import "os"

// flock takes an exclusive, non-blocking lock on an open file. js, wasip1
// and plan9 have no flock(2), and the notice this lock guards prints one
// extra line at worst when two `drive status` runs collide — so those
// builds run the notice unlocked rather than not at all. The caller keeps
// the same zero-byte lock file, so the state beside it is the same on
// every platform.
func flock(*os.File) error { return nil }

// flockEnd releases a lock this platform never took.
func flockEnd(*os.File) {}
