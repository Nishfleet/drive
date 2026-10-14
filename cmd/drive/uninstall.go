package main

import (
	"errors"
	"flag"
	"fmt"
	"os"
)

// Uninstall is `drive uninstall`: stop the mount and remove the login items that start it again, and change nothing else (drive#34, the uninstall slice of the account lifecycle).
func Uninstall(goos, home string) error {
	stopErr := Unmount(goos, home)
	if err := stopMount(goos, home); err != nil {
		if stopErr != nil {
			return fmt.Errorf("could not disable the login item (%v), and the mount did not come down: %w", stopErr, err)
		}
		return err
	}
	if stopErr != nil {
		fmt.Fprintf(os.Stderr, "note: could not disable the login item (%v); it is removed below, so drive will not start at the next login\n", stopErr)
	}
	var removed error
	for _, path := range LoginItemFiles(goos, home) {
		if err := removeIfPresent(path); err != nil {
			removed = errors.Join(removed, err)
		}
	}
	fmt.Printf("uninstalled: the mount is stopped and the login item is removed\n")
	fmt.Printf("your files are still in %s\n", DefaultMountDir(home))
	fmt.Printf("the key and config in %s are kept (drive logout is the command that removes those)\n", DefaultConfigDir(home))
	return removed
}

func runUninstall(args []string) error {
	fs := flag.NewFlagSet("uninstall", flag.ContinueOnError)
	common := addCommonFlags(fs)
	if err := fs.Parse(args); err != nil {
		return errFlagParse
	}
	if fs.NArg() > 0 {
		return fmt.Errorf("unexpected argument %q", fs.Arg(0))
	}
	return Uninstall(CurrentGOOS(), common.home)
}
