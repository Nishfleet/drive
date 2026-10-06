package main

// `drive undo` (drive issue #774, from #13's "let an AI loose on your files,
// undo it in one click"). It rewinds the last branch an agent worked in, so
// the files that branch changed are the ones the drive serves again.
//
// The route is src/rewind.js's `/api/rewind*`, and the rewind itself is
// src/branches.js's discard: the branch's copy goes and the original is left
// exactly as it is. There is no second undo mechanism here and no second
// window: the command reads the preview the route sends — the same preview the
// Rewind tab in the web app renders — and posts that branch back, so the CLI
// and the screen cannot disagree about what a rewind undoes, who made the
// change, or how long it stays available.
//
// `drive undo <branch>` rewinds the branch named. With no argument the command
// picks the newest branch whose window is still open, which is "the last agent
// change" a person means when they type it. A branch that cannot be rewound is
// answered by the route, not by a rule repeated here: the POST comes back with
// the server's own sentence, the same one the screen shows.
//
// Like `drive discard` the command does not prompt. It prints what it is about
// to throw away first, so the line above the result is the decision, and the
// work it removes is the agent's copy rather than anything the person has.

import (
	"errors"
	"flag"
	"fmt"
	"net/url"
	"os"
	"strings"
)

// REWIND_PATH is the CLI's one copy of the route family (src/rewind.js
// REWIND_ENDPOINT), so the command and the server cannot drift.
const REWIND_PATH = "/api/rewind"

// RewindPreview is one branch as /api/rewind lists it (src/rewind.js): the
// files a rewind would undo, whose work it is, and whether the window still
// allows it. `CanRewind` and `UnavailableReason` are the server's decision, so
// the command never second-guesses the route by hiding the POST itself.
type RewindPreview struct {
	Name              string
	SourcePrefix      string
	State             string
	ChangedBy         string
	CreatedAt         string
	AgeDays           int
	WindowDays        int
	RestorableUntil   string
	CanRewind         bool
	UnavailableReason string
	Files             RewindFiles
	Progress          *BranchProgress
}

// RewindFiles is the file lists a rewind would throw away, as the branch's own
// live diff (src/branches.js) reports them.
type RewindFiles struct {
	Added   []string
	Changed []string
	Removed []string
	Count   int
}

type rewindListAnswer struct {
	Rewinds []RewindPreview
}

type rewindOneAnswer struct {
	Rewind RewindPreview
}

type rewindDoneAnswer struct {
	Name      string
	State     string
	Rewound   int
	ChangedBy string
	Progress  *BranchProgress
}

// rewindPathFor names one branch's rewind endpoint. The name is escaped, so a
// name the server accepted is the same name this call asks for back.
func rewindPathFor(name string) string {
	return REWIND_PATH + "/" + url.PathEscape(name)
}

// newestRewindable picks the branch `drive undo` with no argument rewinds.
// The list is a list, not a promise about order, so this compares the instant
// each branch was made rather than trusting the route's own ordering; the
// timestamps are the server's RFC 3339 strings, which sort as they read.
func newestRewindable(previews []RewindPreview) (RewindPreview, bool) {
	best := RewindPreview{}
	found := false
	for _, preview := range previews {
		if !preview.CanRewind {
			continue
		}
		if !found || preview.CreatedAt > best.CreatedAt {
			best = preview
			found = true
		}
	}
	return best, found
}

// rewindLines says what a rewind is about to throw away, in the words the
// person reading it needs: whose work, which folder, and how many files of
// which kind changed. The counts are the preview's own, so a line printed a
// moment before the rewind names the same files the rewind removes.
func rewindLines(preview RewindPreview) []string {
	who := strings.TrimSpace(preview.ChangedBy)
	if who == "" {
		who = "an agent"
	}
	lines := []string{
		fmt.Sprintf("%s worked in %s: %d %s changed (%d added, %d changed, %d removed).",
			who, preview.SourcePrefix, preview.Files.Count, pluralFiles(preview.Files.Count),
			len(preview.Files.Added), len(preview.Files.Changed), len(preview.Files.Removed)),
	}
	for _, file := range preview.Files.Added {
		lines = append(lines, "  added   "+file)
	}
	for _, file := range preview.Files.Changed {
		lines = append(lines, "  changed "+file)
	}
	for _, file := range preview.Files.Removed {
		lines = append(lines, "  removed "+file)
	}
	return lines
}

// runUndo is the whole command: read the preview (the branch named, or the
// newest one that can still be rewound), print what it would throw away, then
// post that branch back.
func runUndo(args []string) error {
	fs := flag.NewFlagSet("undo", flag.ContinueOnError)
	api := fs.String("api", os.Getenv("DRIVE_API_URL"), "api Worker base URL")
	home := fs.String("home", os.Getenv("HOME"), "home directory")
	if err := fs.Parse(args); err != nil {
		return errFlagParse
	}
	if fs.NArg() > 1 {
		return errors.New("usage: drive undo [branch]")
	}
	client, err := branchClient(*home, *api)
	if err != nil {
		return err
	}
	preview, err := undoPreview(client, fs.Arg(0))
	if err != nil {
		return err
	}
	if strings.TrimSpace(preview.Name) == "" {
		fmt.Println("nothing to undo. A branch an agent works in stays rewindable for 30 days.")
		return nil
	}
	for _, line := range rewindLines(preview) {
		fmt.Println(line)
	}
	return undoNow(client, preview.Name)
}

// undoPreview reads what a rewind would undo: one named branch, or the newest
// rewindable branch on the account. A name the account has no branch for is
// the route's own 404 sentence, and no branch can be rewound is an empty
// preview rather than an error, so the caller can say so in one line.
func undoPreview(client *APIClient, name string) (RewindPreview, error) {
	if strings.TrimSpace(name) != "" {
		var answer rewindOneAnswer
		if err := client.do("GET", rewindPathFor(name), nil, &answer); err != nil {
			return RewindPreview{}, err
		}
		return answer.Rewind, nil
	}
	var answer rewindListAnswer
	if err := client.do("GET", REWIND_PATH, nil, &answer); err != nil {
		return RewindPreview{}, err
	}
	newest, ok := newestRewindable(answer.Rewinds)
	if !ok {
		return RewindPreview{}, nil
	}
	return newest, nil
}

// undoNow does it. The job can still be in flight when the route answers, so
// this waits the branch out the same way `drive discard` does, and reports the
// same way: the branch's copy is gone and the original was never named.
func undoNow(client *APIClient, name string) error {
	var answer rewindDoneAnswer
	if err := client.post(rewindPathFor(name), map[string]string{}, &answer); err != nil {
		return err
	}
	if isBranchJobState(answer.State) {
		waited, waitErr := waitForBranch(client, name)
		if waitErr != nil {
			return waitErr
		}
		answer.State = waited.State
		if waited.Progress != nil {
			answer.Rewound = waited.Progress.Done
		}
	}
	if answer.State != "discarded" {
		return fail("unexpected")
	}
	who := strings.TrimSpace(answer.ChangedBy)
	if who == "" {
		who = "the agent"
	}
	fmt.Printf("rewound %s's work in branch %q (%d %s removed; the original is untouched)\n",
		who, answer.Name, answer.Rewound, pluralFiles(answer.Rewound))
	return nil
}
