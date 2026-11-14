//go:build windows

package main

import "os"

func flock(*os.File) error { return nil }

func flockEnd(*os.File) {}
