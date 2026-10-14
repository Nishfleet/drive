package main

import (
	"errors"
	"flag"
	"fmt"
	"net/url"
	"os"
	"strings"
)

// REWIND_PATH is the CLI's one copy of the route family (src/rewind.js REWIND_ENDPOINT), so the command and the server cannot drift.
const REWIND_PATH = "/api/rewind"

// RewindPreview is one branch as /api/rewind lists it (src/rewind.js): the files a rewind would undo, whose work it is, and whether the window still allows it.
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

// RewindFiles is the file lists a rewind would throw away, as the branch's own live diff (src/branches.js) reports them.
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

func rewindPathFor(name string) string {
	return REWIND_PATH + "/" + url.PathEscape(name)
}

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

func runUndo(args []string) error {
	fs := flag.NewFlagSet("undo", flag.ContinueOnError)
	api := fs.String("api", os.Getenv("DRIVE_API_URL"), "api Worker base URL")
	home := fs.String("home", DefaultHome(), "home directory")
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

func undoPreview(client *APIClient, name string) (RewindPreview, error) {
	if strings.TrimSpace(name) != "" {
		var answer rewindOneAnswer
		if err := client.Do("GET", rewindPathFor(name), nil, &answer); err != nil {
			return RewindPreview{}, err
		}
		return answer.Rewind, nil
	}
	var answer rewindListAnswer
	if err := client.Do("GET", REWIND_PATH, nil, &answer); err != nil {
		return RewindPreview{}, err
	}
	newest, ok := newestRewindable(answer.Rewinds)
	if !ok {
		return RewindPreview{}, nil
	}
	return newest, nil
}

func undoNow(client *APIClient, name string) error {
	var answer rewindDoneAnswer
	if err := client.Post(rewindPathFor(name), map[string]string{}, &answer); err != nil {
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
		return fail("unexpected rewind state " + answer.State)
	}
	who := strings.TrimSpace(answer.ChangedBy)
	if who == "" {
		who = "the agent"
	}
	fmt.Printf("rewound %s's work in branch %q (%d %s removed; the original is untouched)\n",
		who, answer.Name, answer.Rewound, pluralFiles(answer.Rewound))
	return nil
}
