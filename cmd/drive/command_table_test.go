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

// noteCommandRe matches a backticked span that names a drive subcommand, as
// both notes write them: `drive search <words>`, `drive cache --max 5G`. A
// bare `drive` (the MCP server's name in the notes) has no word after it
// and does not match.
var noteCommandRe = regexp.MustCompile("`drive ([a-z]+)")

// noteCommands lists the subcommands a note names, in note order.
func noteCommands(note string) []string {
	var out []string
	for _, m := range noteCommandRe.FindAllStringSubmatch(note, -1) {
		out = append(out, m[1])
	}
	return out
}

// TestNotesNameOnlyRealCommands holds both agent notes to the command
// table: the in-folder note (CLAUDE.md / AGENTS.md, noteBody) and the skill
// note (SKILL.md / steering, skillBody) may name only subcommands main
// dispatches, so `drive init` can never again advertise a command that
// does not exist.
func TestNotesNameOnlyRealCommands(t *testing.T) {
	for _, note := range []struct{ name, body string }{
		{"the in-folder note", noteBody("/drive")},
		{"the skill note", skillBody("/drive")},
	} {
		named := noteCommands(note.body)
		if len(named) == 0 {
			t.Fatalf("%s names no commands; the gate is checking nothing", note.name)
		}
		for _, cmd := range named {
			if _, ok := commands[cmd]; !ok {
				t.Errorf("%s names `drive %s`, which is not a subcommand (drive --help lists the real ones)", note.name, cmd)
			}
		}
	}
}

// TestHelpListsEveryCommand holds `drive --help` to the same table: every
// subcommand main dispatches is documented in usage, so a shipped command
// the help text does not mention is caught the same way (prefetch was).
func TestHelpListsEveryCommand(t *testing.T) {
	names := make([]string, 0, len(commands))
	for name := range commands {
		names = append(names, name)
	}
	sort.Strings(names)
	for _, name := range names {
		if !strings.Contains(usage, "drive "+name) {
			t.Errorf("drive --help does not mention `drive %s`", name)
		}
	}
}
