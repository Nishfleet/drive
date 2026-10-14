package main

import (
	"flag"
	"fmt"
)

const (
	pausedLabel  = "Paused"
	pausedNote   = "Uploads are slowed. Run drive resume to start them again."
	resumedLabel = "Resumed"
	resumedNote  = "Uploads are moving again."
)

const transfersRunning = "transfers: running"

const transfersNotMounted = "transfers: not mounted"

func pausedLine() string { return pausedLabel }

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
