package main

import (
	"flag"
	"fmt"
)

// `drive pause` and `drive resume` (drive issue #100). They use rclone's own
// remote-control API (rclone.org/rc), measured on this host 2026-10-03
// (rclone v1.75.1, `rclone serve s3` stand-in, FUSE mount in a user namespace):
//
//   - pause:   rc vfs/queue-set-expiry with a far-future expiry on every
//     waiting item (rclone's documented delay), then rc core/bwlimit
//     rate="1KiB:off" for the one already in flight. rclone has no zero
//     rate: 0 means "off". The in-flight chunk can finish; waiting files
//     stay in rclone's queue until resume.
//   - resume:  rc vfs/queue-set-expiry with a large negative expiry (upload
//     as soon as possible) and core/bwlimit rate=off.
//
// The remote control is the one the mount already binds (mount.go
// `--rc-addr`, RCAddr()), through the one client in this CLI (rc.go extends
// the fill loop's rcClient), so no second listener and no second rc path exist.
//
// No queue, no transfer bookkeeping and no scheduler is written here: rclone
// already owns the queue (rc vfs/queue) and the rate. The only state this CLI
// keeps is the marker, which is what makes the pause survive a restart of the
// mount: BuildMountPlan puts the paused rate on rclone's command line.

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

// runPause is `drive pause`: hold rclone's upload queue, cap the in-flight
// transfer, and remember it so the next mount starts paused too.
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
	on, err := Mounted(CurrentGOOS(), home)
	if err != nil {
		return err
	}
	// Already paused with no mount is a state, not a failure. When the mount
	// is up, the live rate is applied even if the marker is already there, so
	// a marker that drifted from rclone cannot claim a pause rclone is not
	// doing.
	if !on && Paused(home) {
		fmt.Println(pausedLine())
		fmt.Println(pausedNote)
		return nil
	}
	if on {
		if err := applyPauseToMount(home); err != nil {
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

func applyPauseToMount(home string) error {
	c, err := mountRCClient(home)
	if err != nil {
		return err
	}
	ctx, cancel := rcCtx()
	defer cancel()
	if err := c.HoldQueuedUploads(ctx); err != nil {
		return err
	}
	return c.SetBwLimit(ctx, pausedRate)
}

func applyResumeToMount(home string) error {
	c, err := mountRCClient(home)
	if err != nil {
		return err
	}
	ctx, cancel := rcCtx()
	defer cancel()
	if err := c.ReleaseQueuedUploads(ctx); err != nil {
		return err
	}
	return c.SetBwLimit(ctx, resumeRate)
}

// runResume is `drive resume`: release rclone's queue and lift the rate cap.
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
	on, err := Mounted(CurrentGOOS(), home)
	if err != nil {
		return err
	}
	if !on && !Paused(home) {
		fmt.Println(resumedLabel)
		fmt.Println(resumedNote)
		return nil
	}
	if on {
		if err := applyResumeToMount(home); err != nil {
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
