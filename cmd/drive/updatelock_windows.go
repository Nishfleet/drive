//go:build windows

package main

import "os"

// Windows has no flock(2).
func flock(*os.File) error { return nil }

func flockEnd(*os.File) {}
