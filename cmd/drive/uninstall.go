package main

import (
	"errors"
	"flag"
	"fmt"
	"os"
)

// Uninstall is `drive uninstall`: stop the mount and remove the login
// items that start it again, and change nothing else (drive#34, the
// uninstall slice of the account lifecycle).
//
// It is not `drive logout`. Logout signs this device out: it stops the
// mount, revokes the device's key on the server and deletes the local
// key and config, so nothing secret is left on disk. Uninstall takes
// the drive out of this machine's startup only: the key in
// ~/.config/drive/rclone.conf, the config directory and the drive
// folder — the person's files — are all left exactly as they were, so
// a later `drive mount` works again with the same key.
//
// The unmount logic is the one logout uses, not a second path to it:
// Unmount stops the prefetch sidecar and disables both login items,
// and stopMount brings the mount point itself down and proves it
// through the kernel. As in logout, a failed login-item disable is
// noted rather than fatal: the item file is removed right after, so
// it cannot start the drive at the next login, and stopMount is the
// measured end state. Only a mount that is still up fails the command.
//
// The drive folder is never a candidate for removal. It holds the
// person's files, and taking those is no command's job without being
// asked in so many words; uninstall does not ask, and the success
// line says where the files still are.
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
	// Unmount stops the login items but leaves their files, the way
	// `drive unmount` does; removing them here is what keeps drive from
	// starting at the next login. Both items go: `drive mount` writes
	// the prefetch sidecar alongside the mount item, and an uninstall
	// that left it would start `drive prefetch` at the next login with
	// nothing to prefetch from. A missing item is not an error, so
	// uninstall is safe on a machine that was never mounted.
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

// runUninstall is `drive uninstall`.
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
