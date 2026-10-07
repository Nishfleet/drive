package main

import (
	"regexp"
	"sort"
	"strings"
	"testing"
)

// The command-table gates (drive#461). The notes `drive init` and
// `drive agents connect` write used to advertise `drive restore <file>`,
// which no step has shipped: a session following the note ran a command
// that does not exist. main.go's commands table is the one place a
// subcommand exists, so these tests hold the notes and `drive --help`
// (usage) to that table and neither can drift from what runs.
//
// Both gates run both ways: every command a note or the help names is a
// real one, and every command in the table is in the help.

// mainAnswers names the two commands main.go's switch answers itself,
// outside the table: `drive version` and `drive help` print and exit
// instead of running a command, so they have no run function to table.
// `drive version` is in the help text, so the gates must count it as real.
var mainAnswers = map[string]bool{"version": true, "help": true}

// isRealCommand reports whether name is a command a session can actually run:
// an entry in the table, or one main answers itself.
func isRealCommand(name string) bool {
	if _, ok := commands[name]; ok {
		return true
	}
	return mainAnswers[name]
}

// commandRe matches the first word after `drive` in a note or the help, at a
// word boundary: `drive search <words>`, `drive cache --max 5G`, and a plain
// "run drive restore" in prose. A bare `drive` (the MCP server's name in the
// notes) has no word after it and does not match.
var commandRe = regexp.MustCompile(`\bdrive ([a-z][a-z0-9-]*)\b`)

// commandNames lists the command names a span of text writes, in order.
func commandNames(text string) []string {
	var out []string
	for _, m := range commandRe.FindAllStringSubmatch(text, -1) {
		out = append(out, m[1])
	}
	return out
}

// mentions reports whether text writes `drive <name>` as a whole word, so a
// command named `cap` is not satisfied by a word that starts with it.
func mentions(text, name string) bool {
	return regexp.MustCompile(`\bdrive ` + regexp.QuoteMeta(name) + `\b`).MatchString(text)
}

// noteCommands returns the command lists a note writes: each bullet with its
// continuation lines. A note's prose describes the drive ("the user's drive is
// `<dir>`", "a name in the drive folder") and names no command, so the bullets
// are the commands the note claims exist, in the note's own wording.
func noteCommands(note string) []string {
	var out []string
	lines := strings.Split(note, "\n")
	for i := 0; i < len(lines); i++ {
		if !strings.HasPrefix(lines[i], "- ") {
			continue
		}
		bullet := []string{lines[i]}
		for i+1 < len(lines) && strings.HasPrefix(lines[i+1], "  ") {
			i++
			bullet = append(bullet, lines[i])
		}
		out = append(out, strings.Join(bullet, "\n"))
	}
	return out
}

// TestHelpNamesNoTrackerReference refuses a tracker row id in the help text
// (drive issue #562: `drive --help` used to point at "issue #19" and
// "drive#117", which are private pointers that mean nothing to the person
// reading it). The help text is what a session and a person both read, so the
// gate is a plain-text check of every line of it: nothing in it may name a
// tracker row. The next step is written out here rather than in the message
// table, because the reader of this test is the one writing help text.
func TestHelpNamesNoTrackerReference(t *testing.T) {
	bad := trackerRefRe.FindAllString(usage, -1)
	if len(bad) == 0 {
		return
	}
	t.Errorf("`drive --help` names %d tracker reference(s) (%s). Replace each with what a reader can act on: the page or the command that answers the question, not a row in another system", len(bad), strings.Join(bad, ", "))
}

// trackerRefRe is a tracker row reference: a leading hash, or an
// owner-then-slug form such as drive#117, followed by digits. Size suffixes
// (5G, 500M) and dates (2026-01-02) do not match, so the gate cannot be made
// to pass by rewriting a size.
var trackerRefRe = regexp.MustCompile(`(#|[A-Za-z][A-Za-z0-9_-]*#)\d+`)

// TestHelpNamesTheDocsPageTheStatusLineNames refuses a second address for the
// troubleshooting page. `drive --help`'s usage text is a const string, so it
// prints the page's address as literal words, while status.go and doctor.go
// build the same address from defaultAPIBase at run time. The day the origin
// moves, the const cannot follow on its own, so this gate holds the two copies
// together: a help text that points somewhere else than the CLI does fails
// here rather than sending a reader to a dead address.
func TestHelpNamesTheDocsPageTheStatusLineNames(t *testing.T) {
	want := defaultAPIBase + "/docs/troubleshooting"
	if !strings.Contains(usage, want) {
		t.Errorf("`drive --help` must name the troubleshooting page at %s, the address docsTroubleshootingURL() builds, so the two cannot drift", want)
	}
}

// TestNotesNameOnlyRealCommands holds both agent notes to the command
// table: the in-folder note (CLAUDE.md / AGENTS.md, noteBody) and the skill
// note (SKILL.md / steering, skillBody) may name only commands main runs, in
// code spans or in plain words, so `drive init` can never again advertise a
// command that does not exist.
func TestNotesNameOnlyRealCommands(t *testing.T) {
	for _, note := range []struct{ name, body string }{
		{"the in-folder note", noteBody(Env{DriveDir: "/drive", AgentDir: "/drive-agents/claude"})},
		{"the skill note", skillBody("/drive")},
	} {
		named := noteCommands(note.body)
		if len(named) == 0 {
			t.Fatalf("%s lists no commands; the gate is checking nothing", note.name)
		}
		for _, bullet := range named {
			for _, cmd := range commandNames(bullet) {
				if !isRealCommand(cmd) {
					t.Errorf("%s lists `drive %s`, which is not a command (drive --help lists the real ones)", note.name, cmd)
				}
			}
		}
	}
}

// usageCommands returns the command columns the help text's own list shows:
// each line under "Usage:" up to the gap that starts its description. The
// description is prose ("whether the drive is connected", "from the drive
// index"), and the rest of the help is prose about flags and installs, so the
// column is where the help states which commands exist.
func usageCommands() string {
	start := strings.Index(usage, "Usage:\n")
	if start < 0 {
		return ""
	}
	block := usage[start:]
	if end := strings.Index(block, "\n\n"); end >= 0 {
		block = block[:end]
	}
	var columns []string
	for _, line := range strings.Split(block, "\n") {
		line = strings.TrimPrefix(line, "  ")
		if !strings.HasPrefix(line, "drive ") {
			continue
		}
		column := line
		if gap := strings.Index(line, "  "); gap >= 0 {
			column = line[:gap]
		}
		columns = append(columns, column)
	}
	return strings.Join(columns, "\n")
}

// TestHelpListsEveryCommand holds `drive --help` to the table in both
// directions: every subcommand main dispatches is documented in the help, and
// every command the help's own list names is one main runs. The first caught
// a shipped command the help did not document (prefetch); the second catches a
// documented command that does not exist, which is the note's old bug.
func TestHelpListsEveryCommand(t *testing.T) {
	block := usageCommands()
	if block == "" {
		t.Fatal("the usage const has no `Usage:` command list; the gate is checking nothing")
	}
	listed := commandNames(block)
	if len(listed) == 0 {
		t.Fatal("the usage const's command list names no commands; the gate is checking nothing")
	}
	for _, cmd := range listed {
		if !isRealCommand(cmd) {
			t.Errorf("drive --help documents `drive %s`, which is not a command", cmd)
		}
	}
	names := make([]string, 0, len(commands))
	for name := range commands {
		names = append(names, name)
	}
	sort.Strings(names)
	for _, name := range names {
		if !mentions(block, name) {
			t.Errorf("drive --help does not document `drive %s`, which is a command", name)
		}
	}
}
