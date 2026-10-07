//go:build windows

package main

import "os"

// flock takes an exclusive, non-blocking lock on an open file. Windows has no
// flock(2); LockFileEx needs an overlapped offset and a whole-window call, and
// the notice this lock guards prints one extra line at worst when two
// `drive status` runs collide — so a Windows build runs the notice unlocked
// rather than not at all. The caller keeps the same zero-byte lock file, so
// the state beside it is the same on every platform.
func flock(*os.File) error { return nil }

// flockEnd releases a lock this platform never took.
func flockEnd(*os.File) {}
