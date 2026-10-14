package main

import (
	"flag"
	"fmt"
	"net/url"
	"os"
	"strings"
	"time"
)

// `drive restore` (delight item 1): put back a file that was saved over or
// deleted. The Worker keeps the earlier copy for 30 days, free; this command
// lists the copies of one file and restores one. It is two calls to the
// account routes the Files page uses (core/files-history.js):
// GET /api/files/versions and POST /api/files/restore-version.

const (
	versionsPath       = "/api/files/versions"
	restoreVersionPath = "/api/files/restore-version"
)

// EarlierCopy is one copy the Worker still holds of a file.
type EarlierCopy struct {
	VersionID      string `json:"versionId"`
	Size           int64  `json:"size"`
	SavedAt        string `json:"savedAt"`
	ReplacedAt     string `json:"replacedAt"`
	RestorableTill string `json:"restorableUntil"`
}

type versionsAnswer struct {
	Path     string        `json:"path"`
	Versions []EarlierCopy `json:"versions"`
}

// runRestore is `drive restore <file>`: with no flag it lists the earlier
// copies, newest first; --latest restores the newest one; --copy N restores
// the Nth line of the list. Restoring is a save, so the copy it replaces
// becomes an earlier copy and the undo can be undone.
func runRestore(args []string) error {
	fs := flag.NewFlagSet("restore", flag.ContinueOnError)
	common := addCommonFlags(fs)
	apiFlag := fs.String("api", os.Getenv("DRIVE_API_URL"), "api Worker base URL")
	latest := fs.Bool("latest", false, "restore the newest earlier copy")
	pick := fs.Int("copy", 0, "restore the Nth copy in the list (1 is the newest)")
	if err := fs.Parse(args); err != nil {
		return errFlagParse
	}
	if fs.NArg() != 1 {
		fmt.Fprint(os.Stderr, usage)
		return errFlagParse
	}
	if *latest && *pick != 0 {
		return fmt.Errorf("--latest and --copy are two different choices; pick one")
	}
	path, err := drivePathArg(common.home, fs.Arg(0))
	if err != nil {
		return err
	}
	base, err := resolveAPIBase(common.home, *apiFlag)
	if err != nil {
		return err
	}
	if strings.TrimSpace(base) == "" {
		return fail("no-api")
	}
	parsed, err := parseAPIBase(base)
	if err != nil {
		return failDetail("api-url", err)
	}
	return withFreshDeviceToken(common.home, *apiFlag, os.Stdout, func(auth string) error {
		var found versionsAnswer
		if err := getJSON(parsed+versionsPath+"?path="+url.QueryEscape(path), auth, &found); err != nil {
			return err
		}
		if len(found.Versions) == 0 {
			fmt.Printf("no earlier copies of %s. A copy shows up after you save over the file or delete it, and stays for 30 days.\n", path)
			return nil
		}
		choice := *pick
		if *latest {
			choice = 1
		}
		if choice == 0 {
			printEarlierCopies(path, found.Versions)
			fmt.Printf("restore one with: drive restore %s --copy N   (or --latest)\n", path)
			return nil
		}
		if choice < 1 || choice > len(found.Versions) {
			return fmt.Errorf("there is no copy %d of %s; it has %d", choice, path, len(found.Versions))
		}
		copyToRestore := found.Versions[choice-1]
		var done struct {
			OK bool `json:"ok"`
		}
		body := map[string]string{"path": path, "versionId": copyToRestore.VersionID}
		if err := postJSON(parsed+restoreVersionPath, auth, body, &done); err != nil {
			return err
		}
		fmt.Printf("put back %s (%s saved %s). The copy it replaced is now an earlier copy.\n",
			path, fileSize(copyToRestore.Size), shortTime(copyToRestore.SavedAt))
		return nil
	})
}

// printEarlierCopies lists the copies newest first, each with the day it is
// removed for good.
func printEarlierCopies(path string, copies []EarlierCopy) {
	fmt.Printf("earlier copies of %s:\n", path)
	for i, c := range copies {
		fmt.Printf("  %d. %s, saved %s, replaced %s, permanently removed %s\n",
			i+1, fileSize(c.Size), shortTime(c.SavedAt), shortTime(c.ReplacedAt), shortTime(c.RestorableTill))
	}
}

// shortTime renders the Worker's ISO time as a date and minute, or the raw
// text when it does not parse.
func shortTime(iso string) string {
	t, err := time.Parse(time.RFC3339, iso)
	if err != nil {
		return iso
	}
	return t.Local().Format("Jan 2 15:04")
}
