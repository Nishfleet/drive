package main

// The branch commands (drive issue #8, build step 7): branch a folder for an
// agent to work in, list branches, see the diff, approve it back or throw it
// away. One HTTP family, /api/branches* (src/branches.js), spoken with the
// same device token `drive init` signed in with, so the branch the CLI names,
// the diff it prints and the state the server records cannot disagree.
//
// `drive branch` copies a folder server-side into `.branches/<name>/`; the
// branch name defaults to the folder's own name, and `--name` picks another
// when that one is taken.

import (
	"errors"
	"flag"
	"fmt"
	"net/url"
	"os"
	"path"
	"strings"
)

// BranchSummary is one branch as /api/branches lists it (src/branches.js). A
// failure is an APIError from the client, whose message already carries the
// server's sentence, so there is no error field to decode here.
type BranchSummary struct {
	Name          string
	SourcePrefix  string
	BranchPrefix  string
	State         string
	CreatedAt     string
	Files         int
	Changed       int
	SourceChanged int
}

// BranchDiff is the file lists /api/branches/<name> answers with.
type BranchDiff struct {
	Added         []string
	Changed       []string
	Removed       []string
	SourceChanged []string
}

type branchListAnswer struct {
	Branches []BranchSummary
}

type branchCreateAnswer struct {
	Branch BranchSummary
}

type branchDiffAnswer struct {
	Branch BranchSummary
	Diff   BranchDiff
}

type branchApproveAnswer struct {
	Name    string
	State   string
	Applied BranchDiff
}

type branchDiscardAnswer struct {
	Name    string
	State   string
	Removed int
}

// BRANCHES_PATH is the CLI's one copy of the route family (src/branches.js
// BRANCHES_ENDPOINT), so the commands and the server cannot drift.
const BRANCHES_PATH = "/api/branches"

// branchClient builds the client every branch command uses. The api base is
// the deployment's own (--api / DRIVE_API_URL), falling back to the base
// `drive init` signed in to, and the token is this device's, so a branch is
// made and approved as the signed-in account.
func branchClient(home, api string) (*APIClient, error) {
	creds, err := LoadCredentials(home)
	if err != nil {
		return nil, err
	}
	base := strings.TrimSpace(api)
	if base == "" {
		base = creds.APIBase
	}
	if base == "" {
		return nil, errors.New("no api Worker configured; set --api or DRIVE_API_URL")
	}
	if strings.TrimSpace(creds.DeviceToken) == "" {
		return nil, errors.New("this device is not signed in yet; run `drive init` first")
	}
	return NewAPIClient(base, creds.DeviceToken)
}

// branchPathFor names one branch's endpoint. The name is escaped, so a name
// the server accepted is the same name this call asks for back.
func branchPathFor(name string) string {
	return BRANCHES_PATH + "/" + url.PathEscape(name)
}

// defaultBranchName is the branch name a folder gets when --name is not given:
// the folder's own name, the way a person would say it. The root has no name
// of its own, so it becomes "root". A folder name that is not a legal branch
// name (a space, say) falls back to "branch", so `drive branch "/My Photos"`
// works and the person can still pass --name for the one they want; the
// server's own checkedBranchName is the only place a name is judged.
func defaultBranchName(folder string) string {
	trimmed := strings.TrimRight(folder, "/")
	if trimmed == "" {
		return "root"
	}
	name := path.Base(trimmed)
	if name == "/" || name == "." || name == "" {
		return "root"
	}
	for _, r := range name {
		switch {
		case r >= 'a' && r <= 'z', r >= 'A' && r <= 'Z', r >= '0' && r <= '9':
		case r == '.', r == '-', r == '_':
		default:
			return "branch"
		}
	}
	if strings.Contains(name, "..") || len(name) > 64 {
		return "branch"
	}
	return name
}

func runBranch(args []string) error {
	fs := flag.NewFlagSet("branch", flag.ContinueOnError)
	api := fs.String("api", os.Getenv("DRIVE_API_URL"), "api Worker base URL")
	home := fs.String("home", os.Getenv("HOME"), "home directory")
	name := fs.String("name", "", "branch name (the folder's own name unless given)")
	if err := fs.Parse(args); err != nil {
		return errFlagParse
	}
	if fs.NArg() != 1 {
		return errors.New("usage: drive branch <folder> [--name <n>]")
	}
	folder := fs.Arg(0)
	if !strings.HasPrefix(folder, "/") {
		folder = "/" + folder
	}
	branchName := *name
	if strings.TrimSpace(branchName) == "" {
		branchName = defaultBranchName(folder)
	}
	client, err := branchClient(*home, *api)
	if err != nil {
		return err
	}
	var answer branchCreateAnswer
	if err := client.post(BRANCHES_PATH, map[string]string{"folder": folder, "name": branchName}, &answer); err != nil {
		return err
	}
	fmt.Printf("created branch %q from %s (%d %s)\n",
		answer.Branch.Name, answer.Branch.SourcePrefix, answer.Branch.Files, pluralFiles(answer.Branch.Files))
	fmt.Printf("  %s\n", answer.Branch.BranchPrefix)
	return nil
}

func runBranches(args []string) error {
	fs := flag.NewFlagSet("branches", flag.ContinueOnError)
	api := fs.String("api", os.Getenv("DRIVE_API_URL"), "api Worker base URL")
	home := fs.String("home", os.Getenv("HOME"), "home directory")
	if err := fs.Parse(args); err != nil {
		return errFlagParse
	}
	if fs.NArg() > 0 {
		return fmt.Errorf("unexpected argument %q", fs.Arg(0))
	}
	client, err := branchClient(*home, *api)
	if err != nil {
		return err
	}
	var answer branchListAnswer
	if err := client.do("GET", BRANCHES_PATH, nil, &answer); err != nil {
		return err
	}
	if len(answer.Branches) == 0 {
		fmt.Println("no branches yet. Make one with `drive branch <folder>`.")
		return nil
	}
	for _, branch := range answer.Branches {
		line := fmt.Sprintf("%s\t%s\t%d changed\tfrom %s",
			branch.Name, branch.State, branch.Changed, branch.SourcePrefix)
		if branch.SourceChanged > 0 {
			line += fmt.Sprintf("\t(the original changed: %d %s)",
				branch.SourceChanged, pluralFiles(branch.SourceChanged))
		}
		fmt.Println(line)
	}
	return nil
}

func runDiff(args []string) error {
	fs := flag.NewFlagSet("diff", flag.ContinueOnError)
	api := fs.String("api", os.Getenv("DRIVE_API_URL"), "api Worker base URL")
	home := fs.String("home", os.Getenv("HOME"), "home directory")
	if err := fs.Parse(args); err != nil {
		return errFlagParse
	}
	if fs.NArg() != 1 {
		return errors.New("usage: drive diff <branch>")
	}
	client, err := branchClient(*home, *api)
	if err != nil {
		return err
	}
	var answer branchDiffAnswer
	if err := client.do("GET", branchPathFor(fs.Arg(0)), nil, &answer); err != nil {
		return err
	}
	printBranchDiff(answer.Branch.Name, answer.Diff)
	return nil
}

// printBranchDiff renders the four lists the diff carries. The source-changed
// list is the clash approve will stop on, so it is printed last and named.
func printBranchDiff(name string, diff BranchDiff) {
	changed := len(diff.Added) + len(diff.Changed) + len(diff.Removed)
	if changed == 0 && len(diff.SourceChanged) == 0 {
		fmt.Printf("branch %q: no changes\n", name)
		return
	}
	fmt.Printf("branch %q vs the original:\n", name)
	for _, file := range diff.Added {
		fmt.Printf("  added    %s\n", file)
	}
	for _, file := range diff.Changed {
		fmt.Printf("  changed  %s\n", file)
	}
	for _, file := range diff.Removed {
		fmt.Printf("  removed  %s\n", file)
	}
	for _, file := range diff.SourceChanged {
		fmt.Printf("  original changed since branching, approve will stop: %s\n", file)
	}
}

func runApprove(args []string) error {
	fs := flag.NewFlagSet("approve", flag.ContinueOnError)
	api := fs.String("api", os.Getenv("DRIVE_API_URL"), "api Worker base URL")
	home := fs.String("home", os.Getenv("HOME"), "home directory")
	if err := fs.Parse(args); err != nil {
		return errFlagParse
	}
	if fs.NArg() != 1 {
		return errors.New("usage: drive approve <branch>")
	}
	client, err := branchClient(*home, *api)
	if err != nil {
		return err
	}
	var answer branchApproveAnswer
	if err := client.post(branchPathFor(fs.Arg(0))+"/approve", map[string]string{}, &answer); err != nil {
		return err
	}
	applied := len(answer.Applied.Added) + len(answer.Applied.Changed) + len(answer.Applied.Removed)
	fmt.Printf("approved branch %q: %d %s copied back\n", answer.Name, applied, pluralFiles(applied))
	return nil
}

func runDiscard(args []string) error {
	fs := flag.NewFlagSet("discard", flag.ContinueOnError)
	api := fs.String("api", os.Getenv("DRIVE_API_URL"), "api Worker base URL")
	home := fs.String("home", os.Getenv("HOME"), "home directory")
	if err := fs.Parse(args); err != nil {
		return errFlagParse
	}
	if fs.NArg() != 1 {
		return errors.New("usage: drive discard <branch>")
	}
	client, err := branchClient(*home, *api)
	if err != nil {
		return err
	}
	var answer branchDiscardAnswer
	if err := client.post(branchPathFor(fs.Arg(0))+"/discard", map[string]string{}, &answer); err != nil {
		return err
	}
	fmt.Printf("discarded branch %q (%d %s removed; the original is untouched)\n",
		answer.Name, answer.Removed, pluralFiles(answer.Removed))
	return nil
}

func pluralFiles(n int) string {
	if n == 1 {
		return "file"
	}
	return "files"
}
