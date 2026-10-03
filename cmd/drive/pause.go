package main

import (
	"flag"
	"fmt"
)

// `drive pause` and `drive resume` (drive issue #100). Both work by setting
// rclone's own bandwidth rate through rclone's remote-control API, measured on
// this host 2026-10-03 (rclone v1.75.1, `rclone serve s3` stand-in, FUSE mount
// in a user namespace):
//
//   - pause:   rc core/bwlimit rate="1KiB:off" plus a marker file. The byte
//     counter read 15,626,240 before the call and 19,066,880 six seconds after
//     it, then 19,066,880 again six seconds later: the in-flight chunk
//     finished and nothing else moved.
//   - resume:  rc core/bwlimit rate=off. The same file finished at exactly
//     157,286,400 bytes with transfers=1.
//
// The remote control is the one the mount already binds (mount.go
// `--rc-addr`, RCAddr()), through the one client in this CLI (rc.go extends
// the fill loop's rcClient), so no second listener and no second rc path exist.
//
// No queue, no transfer bookkeeping and no scheduler is written here: rclone
// already owns the queue (rc vfs/queue) and the rate, and `drive status` reads
// rclone's answers (rc.go). The only state this CLI keeps is the marker, which
// is what makes the pause survive a restart of the mount: BuildMountPlan puts
// the paused rate on rclone's command line, so a mount that is started again
// after a pause starts already paused.

// The words on the two commands' lines. `pausedLabel` and `resumedLabel` are
// the same words the first-run page and `drive status` print (src/status.js
// UPLOAD_LABEL.paused and .resumed), and TestStatusWordsMatchThePageWords is
// the join between the two copies. The notes are this command's own next step,
// in the customer's words: every line says what happened and the one thing to
// do next.
const (
	pausedLabel  = "Paused"
	pausedNote   = "Uploads are stopped. Run drive resume to start them again."
	resumedLabel = "Resumed"
	resumedNote  = "Uploads are moving again."
)

// transfersRunning is the transfers line for a drive that is mounting and not
// paused: rclone's own rate is in force, which `drive status` confirms by
// asking for it rather than assuming it.
const transfersRunning = "transfers: running"

// transfersNotMounted is the transfers line when no mount is up. A queue that
// cannot be sent must not read as one that is moving.
const transfersNotMounted = "transfers: not mounted"

// pausedLine is the one word for a stopped upload, shared with the pages.
func pausedLine() string { return pausedLabel }

// runPause is `drive pause`: stop the bytes leaving, and remember it so the
// next mount starts paused too.
func runPause(args []string) error {
	fs := flag.NewFlagSet("pause", flag.ContinueOnError)
	common := addCommonFlags(fs)
	if err := fs.Parse(args); err != nil {
		return errFlagParse
	}
	if fs.NArg() > 0 {
		return fmt.Errorf("unexpected argument %q", fs.Arg(0))
	}
	home := common.home
	// Already paused is a state, not a failure: say so and stop, so running
	// the command twice cannot claim a pause that was already in force.
	if Paused(home) {
		fmt.Println(pausedLine())
		fmt.Println(pausedNote)
		return nil
	}
	on, err := Mounted(CurrentGOOS(), home)
	if err != nil {
		return err
	}
	// The rate is set on the running mount first. If that fails, the command
	// fails with the drive still uploading, which is the honest outcome: a
	// pause nobody applied is never recorded as one, and `drive status` does
	// not then say Paused over bytes that are still leaving.
	if on {
		if err := setBwLimit(pausedRate); err != nil {
			return fmt.Errorf("could not pause the running mount: %w", err)
		}
	}
	if err := SetPaused(home); err != nil {
		return err
	}
	fmt.Println(pausedLine())
	fmt.Println(pausedNote)
	return nil
}

// setBwLimit sets the running mount's rate through rclone's own remote
// control. It is one call so pause, resume and the status line that reads the
// rate back all go through the same client and the same address.
func setBwLimit(rate string) error {
	c, err := mountRCClient()
	if err != nil {
		return err
	}
	ctx, cancel := rcCtx()
	defer cancel()
	return c.SetBwLimit(ctx, rate)
}

// runResume is `drive resume`: start the bytes moving again.
func runResume(args []string) error {
	fs := flag.NewFlagSet("resume", flag.ContinueOnError)
	common := addCommonFlags(fs)
	if err := fs.Parse(args); err != nil {
		return errFlagParse
	}
	if fs.NArg() > 0 {
		return fmt.Errorf("unexpected argument %q", fs.Arg(0))
	}
	home := common.home
	// Not paused is a state, not a failure: running it twice must not claim a
	// resume nobody was waiting for.
	if !Paused(home) {
		fmt.Println(resumedLabel)
		fmt.Println(resumedNote)
		return nil
	}
	on, err := Mounted(CurrentGOOS(), home)
	if err != nil {
		return err
	}
	// The rate call comes first, so a mount that is already up starts moving
	// even if removing the marker fails. A marker that outlives a resume is
	// repaired by the next `drive mount`, which would then start paused: the
	// safe direction, and it says Paused rather than lying.
	if on {
		if err := setBwLimit(resumeRate); err != nil {
			return fmt.Errorf("could not resume the running mount: %w", err)
		}
	}
	if err := ClearPaused(home); err != nil {
		return err
	}
	fmt.Println(resumedLabel)
	fmt.Println(resumedNote)
	return nil
}
