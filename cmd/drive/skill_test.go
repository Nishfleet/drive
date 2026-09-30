package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// TestEveryToolHasASkillLocation guards the promise the spec makes: every tool
// `drive init` connects also gets a skill note. A new registry row without a
// skill path is a silent gap, so the test fails instead.
func TestEveryToolHasASkillLocation(t *testing.T) {
	env, _ := testEnv(t)
	for _, tool := range tools() {
		path, ok := tool.SkillPath(env)
		if !ok {
			t.Errorf("%s has no skill note path; every tool the spec names needs one", tool.Name)
			continue
		}
		if !filepath.IsAbs(path) {
			t.Errorf("%s skill path %q is not absolute", tool.Name, path)
		}
	}
}

// TestSkillPathsAreEachToolsOwnDocumentedLocation pins the five paths, so a
// future edit cannot quietly move a note somewhere the tool does not read.
// Each is the personal-skill (or global steering) location from the tool's
// current docs, checked 2026-09-30; see the table in skill.go.
func TestSkillPathsAreEachToolsOwnDocumentedLocation(t *testing.T) {
	env, _ := testEnv(t)
	cases := map[string]string{
		"claude": ".claude/skills/drive/SKILL.md",
		"codex":  ".agents/skills/drive/SKILL.md",
		"gemini": ".gemini/skills/drive/SKILL.md",
		"cursor": ".cursor/skills/drive/SKILL.md",
		"kiro":   ".kiro/steering/drive.md",
	}
	if len(cases) != len(tools()) {
		t.Fatalf("the case table has %d rows for %d tools", len(cases), len(tools()))
	}
	for name, want := range cases {
		t.Run(name, func(t *testing.T) {
			tool, err := toolByName(name)
			if err != nil {
				t.Fatal(err)
			}
			path, ok := tool.SkillPath(env)
			if !ok {
				t.Fatalf("%s has no skill path", name)
			}
			rel, err := filepath.Rel(env.Home, path)
			if err != nil {
				t.Fatal(err)
			}
			if rel != want {
				t.Errorf("%s skill path = %s, want %s", name, rel, want)
			}
		})
	}
}

// TestSkillPathReportsAToolWithNoDocumentedLocation: a tool with no skill
// location reports it instead of a path, so nothing is written to a guess.
func TestSkillPathReportsAToolWithNoDocumentedLocation(t *testing.T) {
	env, _ := testEnv(t)
	if path, ok := (Tool{Name: "vim"}).SkillPath(env); ok {
		t.Errorf("a tool with no documented skill location returned %q", path)
	}
}

// TestConnectWritesTheSkillNote proves the note the spec asks for: where the
// drive is, that deletes can be undone, and to branch before large edits.
func TestConnectWritesTheSkillNote(t *testing.T) {
	for _, name := range toolNames() {
		t.Run(name, func(t *testing.T) {
			env, _ := testEnv(t)
			tool, err := toolByName(name)
			if err != nil {
				t.Fatal(err)
			}
			if err := tool.Connect(env); err != nil {
				t.Fatal(err)
			}
			path, _ := tool.SkillPath(env)
			text := readFile(t, path)
			for _, want := range []string{skillMarker, env.DriveDir, "drive restore", "drive branch"} {
				if !strings.Contains(text, want) {
					t.Errorf("%s skill note is missing %q:\n%s", name, want, text)
				}
			}
		})
	}
}

// TestSkillNoteLoadsOutsideTheDriveFolder is the point of a skill note: the
// file must sit in the tool's own skills directory, not inside the drive
// folder, so a session that never opens the drive still gets it. The in-folder
// note is the same content at a path only a session started there reads.
func TestSkillNoteLivesOutsideTheDriveFolder(t *testing.T) {
	env, _ := testEnv(t)
	tool, err := toolByName("claude")
	if err != nil {
		t.Fatal(err)
	}
	if err := tool.Connect(env); err != nil {
		t.Fatal(err)
	}
	path, _ := tool.SkillPath(env)
	rel, err := filepath.Rel(env.DriveDir, path)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(rel, "..") {
		t.Fatalf("the skill note %s is inside the drive folder, so a session outside it never reads it", path)
	}
}

// TestWriteSkillIsIdempotent: `drive init` must be safe to run again, and a
// second connect must not append the note twice.
func TestWriteSkillIsIdempotent(t *testing.T) {
	env, _ := testEnv(t)
	tool, err := toolByName("claude")
	if err != nil {
		t.Fatal(err)
	}
	if err := tool.Connect(env); err != nil {
		t.Fatal(err)
	}
	path, _ := tool.SkillPath(env)
	first := readFile(t, path)
	if err := tool.Connect(env); err != nil {
		t.Fatal(err)
	}
	second := readFile(t, path)
	if second != first {
		t.Fatalf("a second connect changed the note:\n%s\n%s", first, second)
	}
	if n := strings.Count(second, skillMarker); n != 1 {
		t.Fatalf("the note appears %d times:\n%s", n, second)
	}
}

// TestWriteSkillUpdatesTheNoteInPlace: when the drive folder moves, the note
// must follow it rather than keeping a stale path next to a fresh copy.
func TestWriteSkillUpdatesTheNoteInPlace(t *testing.T) {
	env, _ := testEnv(t)
	tool, err := toolByName("claude")
	if err != nil {
		t.Fatal(err)
	}
	if err := tool.Connect(env); err != nil {
		t.Fatal(err)
	}
	moved := Env{Home: env.Home, DriveDir: filepath.Join(env.Home, "OtherDrive"), Runner: env.Runner, LookPath: env.LookPath}.withDefaults()
	if err := writeSkill(moved, filepath.Join(moved.Home, ".claude", "skills", skillName, "SKILL.md")); err != nil {
		t.Fatal(err)
	}
	text := readFile(t, filepath.Join(moved.Home, ".claude", "skills", skillName, "SKILL.md"))
	if !strings.Contains(text, moved.DriveDir) {
		t.Fatalf("the note does not name the new drive folder:\n%s", text)
	}
	if strings.Contains(text, env.DriveDir) {
		t.Fatalf("the note still names the old drive folder:\n%s", text)
	}
	if n := strings.Count(text, skillMarker); n != 1 {
		t.Fatalf("the note appears %d times:\n%s", n, text)
	}
}

// TestWriteSkillRefusesAFileTheDriveDidNotWrite: the skill path is the drive's
// own name ("drive"). A file the user put there is not the drive's to
// clobber, and replacing it silently would be the exact failure the spec is
// fixing, so the collision is reported and the file is left alone.
func TestWriteSkillRefusesAFileTheDriveDidNotWrite(t *testing.T) {
	env, _ := testEnv(t)
	tool, err := toolByName("claude")
	if err != nil {
		t.Fatal(err)
	}
	path, _ := tool.SkillPath(env)
	const users = "---\nname: drive\n---\n\nmy own note\n"
	writeFile(t, path, users)
	err = writeSkill(env, path)
	if err == nil {
		t.Fatal("expected a collision error, got nil")
	}
	if !strings.Contains(err.Error(), "was not written by the drive") {
		t.Fatalf("unexpected error: %v", err)
	}
	if got := readFile(t, path); got != users {
		t.Fatalf("the user's file was modified:\n%s", got)
	}
}

// TestRevokeRemovesTheDriveNoteAndNothingElse. The note is the drive's own
// file, so revoke takes it away, and the skill directory it created goes too
// when nothing is left in it.
func TestRevokeRemovesTheDriveNoteAndNothingElse(t *testing.T) {
	for _, name := range toolNames() {
		t.Run(name, func(t *testing.T) {
			env, _ := testEnv(t)
			tool, err := toolByName(name)
			if err != nil {
				t.Fatal(err)
			}
			if err := tool.Connect(env); err != nil {
				t.Fatal(err)
			}
			path, _ := tool.SkillPath(env)
			if err := tool.Revoke(env); err != nil {
				t.Fatal(err)
			}
			if _, err := os.Stat(path); !os.IsNotExist(err) {
				t.Fatalf("the note survived the revoke: %s", path)
			}
			dir := filepath.Dir(path)
			if _, err := os.Stat(dir); !os.IsNotExist(err) {
				entries, readErr := os.ReadDir(dir)
				if readErr == nil && len(entries) == 0 {
					t.Errorf("the empty skill directory %s was left behind", dir)
				}
			}
		})
	}
}

func TestRevokeKeepsAFileTheDriveDidNotWrite(t *testing.T) {
	env, _ := testEnv(t)
	tool, err := toolByName("claude")
	if err != nil {
		t.Fatal(err)
	}
	path, _ := tool.SkillPath(env)
	writeFile(t, path, "my own note, not the drive's\n")
	if err := tool.Revoke(env); err != nil {
		t.Fatal(err)
	}
	if got := readFile(t, path); !strings.Contains(got, "my own note") {
		t.Fatalf("revoke deleted a file the drive did not write: %q", got)
	}
}

func TestRevokeOnAnAbsentNoteIsFine(t *testing.T) {
	env, _ := testEnv(t)
	tool, err := toolByName("cursor")
	if err != nil {
		t.Fatal(err)
	}
	if err := tool.Revoke(env); err != nil {
		t.Fatalf("revoking a tool with no note should succeed: %v", err)
	}
}

// TestConnectFailsLoudlyWhenTheSkillCannotBeWritten: a connected tool whose
// note silently did not land is the exact failure the spec is fixing, so it
// is reported instead of swallowed.
func TestConnectFailsLoudlyWhenTheSkillCannotBeWritten(t *testing.T) {
	env, _ := testEnv(t)
	tool, err := toolByName("claude")
	if err != nil {
		t.Fatal(err)
	}
	path, _ := tool.SkillPath(env)
	// A directory where the skill file belongs: the write cannot succeed.
	if err := os.MkdirAll(path, 0o755); err != nil {
		t.Fatal(err)
	}
	err = tool.Connect(env)
	if err == nil {
		t.Fatal("expected an error when the skill note cannot be written")
	}
	if !strings.Contains(err.Error(), "skill note") {
		t.Fatalf("unexpected error: %v", err)
	}
}
