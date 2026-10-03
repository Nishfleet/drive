//go:build !linux && !darwin

package main

import "fmt"

func newDirWatcher(root string) (dirWatcher, error) {
	return nil, fmt.Errorf("prefetch watch is not supported on this OS")
}
