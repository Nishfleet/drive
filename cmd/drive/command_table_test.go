package main

import (
	"regexp"
	"sort"
	"strings"
	"testing"
)

var mainAnswers = map[string]bool{"version": true, "help": true}

func isRealCommand(name string) bool {
	if _, ok := commands[name]; ok {
		return true
	}
	return mainAnswers[name]
}

var commandRe = regexp.MustCompile(`\bdrive ([a-z][a-z0-9-]*)\b`)

func commandNames(text string) []string {
	var out []string
	for _, m := range commandRe.FindAllStringSubmatch(text, -1) {
		out = append(out, m[1])
	}
	return out
}

func mentions(text, name string) bool {
	return regexp.MustCompile(`\bdrive ` + regexp.QuoteMeta(name) + `\b`).MatchString(text)
}

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

func TestHelpNamesNoTrackerReference(t *testing.T) {
	bad := trackerRefRe.FindAllString(usage, -1)
	if len(bad) == 0 {
		return
	}
	t.Errorf("`drive --help` names %d tracker reference(s) (%s). Replace each with what a reader can act on: the page or the command that answers the question, not a row in another system", len(bad), strings.Join(bad, ", "))
}

var trackerRefRe = regexp.MustCompile(`(#|[A-Za-z][A-Za-z0-9_-]*#)\d+`)

func TestHelpNamesTheDocsPageTheStatusLineNames(t *testing.T) {
	want := defaultAPIBase + "/docs/troubleshooting"
	if !strings.Contains(usage, want) {
		t.Errorf("`drive --help` must name the troubleshooting page at %s, the address docsTroubleshootingURL() builds, so the two cannot drift", want)
	}
}

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
