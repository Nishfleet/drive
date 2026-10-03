package main

import (
	"errors"
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

// TestSkillFileStartsWithTheFrontmatterItsLoaderNeeds: the four SKILL.md
// tools document YAML frontmatter with name and description, and the loaders
// read it from the very start of the file. Kiro steering needs no name or
// description, so its file only makes the default inclusion explicit.
func TestSkillFileStartsWithTheFrontmatterItsLoaderNeeds(t *testing.T) {
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
			if !strings.HasPrefix(text, "---\n") {
				t.Fatalf("%s skill does not start with frontmatter:\n%s", name, text)
			}
			if name == "kiro" {
				if !strings.Contains(text, "inclusion: always") {
					t.Errorf("kiro steering does not set inclusion: always:\n%s", text)
				}
				return
			}
			for _, want := range []string{"name: drive", "description: "} {
				if !strings.Contains(text, want) {
					t.Errorf("%s SKILL.md frontmatter is missing %q:\n%s", name, want, text)
				}
			}
		})
	}
}

// TestConnectWritesTheSkillNote proves the note the spec asks for: where the
// drive is, that there is a search, that deletes can be undone, and to branch
// before large edits.
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
			for _, want := range []string{skillBegin, skillEnd, env.DriveDir, "search_files", "drive search", "the parts an app has opened", "drive cache --max", "drive restore", "drive branch"} {
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
	if n := strings.Count(second, skillBegin); n != 1 {
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
	if err := writeSkill(moved, tool, filepath.Join(moved.Home, ".claude", "skills", skillName, "SKILL.md")); err != nil {
		t.Fatal(err)
	}
	text := readFile(t, filepath.Join(moved.Home, ".claude", "skills", skillName, "SKILL.md"))
	if !strings.Contains(text, moved.DriveDir) {
		t.Fatalf("the note does not name the new drive folder:\n%s", text)
	}
	if strings.Contains(text, env.DriveDir) {
		t.Fatalf("the note still names the old drive folder:\n%s", text)
	}
	if n := strings.Count(text, skillBegin); n != 1 {
		t.Fatalf("the note appears %d times:\n%s", n, text)
	}
}

// TestWriteSkillKeepsTextAfterTheDriveBlock: a user who adds a line after the
// drive's block keeps it; a rewrite replaces only the block between the begin
// and end markers.
func TestWriteSkillKeepsTextAfterTheDriveBlock(t *testing.T) {
	env, _ := testEnv(t)
	tool, err := toolByName("claude")
	if err != nil {
		t.Fatal(err)
	}
	if err := tool.Connect(env); err != nil {
		t.Fatal(err)
	}
	path, _ := tool.SkillPath(env)
	writeFile(t, path, readFile(t, path)+"\n## My notes\n\nkeep me\n")
	moved := Env{Home: env.Home, DriveDir: filepath.Join(env.Home, "OtherDrive"), Runner: env.Runner, LookPath: env.LookPath}.withDefaults()
	if err := writeSkill(moved, tool, path); err != nil {
		t.Fatal(err)
	}
	text := readFile(t, path)
	if !strings.Contains(text, "keep me") {
		t.Fatalf("the text after the drive block was lost:\n%s", text)
	}
	if !strings.Contains(text, moved.DriveDir) {
		t.Fatalf("the drive block was not updated:\n%s", text)
	}
	if n := strings.Count(text, skillBegin); n != 1 {
		t.Fatalf("the block appears %d times:\n%s", n, text)
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
	err = writeSkill(env, tool, path)
	if err == nil {
		t.Fatal("expected a collision error, got nil")
	}
	if !strings.Contains(err.Error(), "is not the drive's skill note") {
		t.Fatalf("unexpected error: %v", err)
	}
	if got := readFile(t, path); got != users {
		t.Fatalf("the user's file was modified:\n%s", got)
	}
}

// TestWriteSkillRefusesAHalfDelimitedBlock: a file that mentions the begin
// marker but has no end marker (or a foreign file that merely contains the
// string) must be a collision, never a silent rewrite or delete.
func TestWriteSkillRefusesAHalfDelimitedBlock(t *testing.T) {
	env, _ := testEnv(t)
	tool, err := toolByName("codex")
	if err != nil {
		t.Fatal(err)
	}
	path, _ := tool.SkillPath(env)
	const half = "---\nname: drive\n---\n" + skillBegin + "\nno end here\n"
	writeFile(t, path, half)
	if err := writeSkill(env, tool, path); err == nil {
		t.Fatal("expected a collision error for a half-delimited block")
	}
	if got := readFile(t, path); got != half {
		t.Fatalf("the file was modified:\n%s", got)
	}
}

// TestRevokeRemovesTheDriveNoteAndNothingElse. The note is the drive's own
// file, so revoke takes it away, and the dedicated drive skill directory goes
// too when nothing is left in it.
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
			if filepath.Base(dir) != skillName {
				return // a shared directory (Kiro's steering dir) is kept
			}
			if _, err := os.Stat(dir); !os.IsNotExist(err) {
				t.Fatalf("the drive's own empty skill directory %s was left behind", dir)
			}
		})
	}
}

// TestRevokeKeepsKirosSharedSteeringDirectory: ~/.kiro/steering holds the
// user's other steering files and may have existed before the drive; revoking
// the drive's file must not delete it.
func TestRevokeKeepsKirosSharedSteeringDirectory(t *testing.T) {
	env, _ := testEnv(t)
	tool, err := toolByName("kiro")
	if err != nil {
		t.Fatal(err)
	}
	if err := tool.Connect(env); err != nil {
		t.Fatal(err)
	}
	if err := tool.Revoke(env); err != nil {
		t.Fatal(err)
	}
	steering := filepath.Join(env.Home, ".kiro", "steering")
	st, err := os.Stat(steering)
	if err != nil {
		t.Fatalf("kiro's steering directory was removed: %v", err)
	}
	if !st.IsDir() {
		t.Fatalf("%s is not a directory", steering)
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

// TestConnectPreflightsTheSkillBeforeRegistering: a collision at the skill
// path must be refused before the tool is registered, so the failure leaves no
// half-applied state (a server registered without its note).
func TestConnectPreflightsTheSkillBeforeRegistering(t *testing.T) {
	env, runner := testEnv(t)
	tool, err := toolByName("claude")
	if err != nil {
		t.Fatal(err)
	}
	path, _ := tool.SkillPath(env)
	writeFile(t, path, "my own skill file\n")
	if err := tool.Connect(env); err == nil {
		t.Fatal("expected the collision to fail the connect")
	}
	if len(runner.calls) != 0 {
		t.Fatalf("Connect registered the tool before refusing the collision: %q", runner.calls)
	}
	if got := readFile(t, path); got != "my own skill file\n" {
		t.Fatalf("the user's file was modified: %q", got)
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

// TestConnectWritesTheSkillNoteBeforeRegistering pins the ordering: the note
// is written first, so a registration that fails afterwards still leaves the
// note in place -- the silent gap the note exists to close is a tool that is
// registered and unexplained, and the note must outlive the registration.
func TestConnectWritesTheSkillNoteBeforeRegistering(t *testing.T) {
	env, runner := testEnv(t)
	runner.fail = errors.New("tool refused")
	env = env.withDefaults()
	tool, err := toolByName("claude")
	if err != nil {
		t.Fatal(err)
	}
	if err := tool.Connect(env); err == nil {
		t.Fatal("expected the registration failure to fail the connect")
	}
	path, _ := tool.SkillPath(env)
	text := readFile(t, path)
	for _, want := range []string{skillBegin, env.DriveDir} {
		if !strings.Contains(text, want) {
			t.Errorf("the note is missing %q after a failed registration:\n%s", want, text)
		}
	}
}

// TestRevokeKeepsUserTextBetweenTheFrontmatterAndTheBlock: the rewrite path
// (planSkill) preserves text between the drive's frontmatter and its block, so
// revoke must preserve the same span. Dropping it there would delete text the
// user wrote.
func TestRevokeKeepsUserTextBetweenTheFrontmatterAndTheBlock(t *testing.T) {
	env, _ := testEnv(t)
	tool, err := toolByName("claude")
	if err != nil {
		t.Fatal(err)
	}
	if err := tool.Connect(env); err != nil {
		t.Fatal(err)
	}
	path, _ := tool.SkillPath(env)
	header := skillHeader(tool.Name)
	const mine = "## Between the markers\n\nuser text, keep me\n"
	writeFile(t, path, header+skillBegin+"\n"+skillEnd+"\n"+mine)
	if err := tool.Revoke(env); err != nil {
		t.Fatal(err)
	}
	if got := readFile(t, path); got != mine {
		t.Fatalf("revoke changed the user's text between the markers:\n%q\nwant\n%q", got, mine)
	}
	// What is left after the revoke is the user's own text at the drive's own
	// name, so a reconnect refuses it as a collision rather than gobbling it:
	// the same rule as a file the drive never wrote.
	if err := tool.Connect(env); err == nil {
		t.Fatal("expected the connect to refuse the user's text as a collision")
	}
	if got := readFile(t, path); got != mine {
		t.Fatalf("the collision failed the connect but changed the user's text:\n%q", got)
	}
}

// TestWriteSkillRefusesASecondDriveBlock: a file that somehow holds two drive
// blocks is not a file the drive wrote (a partial revoke or a manual paste),
// and rewriting only the first would leave the second, so it is refused as a
// collision instead of being rewritten.
func TestWriteSkillRefusesASecondDriveBlock(t *testing.T) {
	env, _ := testEnv(t)
	tool, err := toolByName("claude")
	if err != nil {
		t.Fatal(err)
	}
	path, _ := tool.SkillPath(env)
	if err := tool.Connect(env); err != nil {
		t.Fatal(err)
	}
	first := readFile(t, path)
	pasted := first + "\n" + skillBegin + "\nstale copy\n" + skillEnd + "\n"
	writeFile(t, path, pasted)
	if err := writeSkill(env, tool, path); err == nil {
		t.Fatal("expected a second drive block to be refused")
	}
	if got := readFile(t, path); got != pasted {
		t.Fatalf("the file was rewritten when it should have been refused:\n%s", got)
	}
}

// TestRevokeKeepsUserTextAfterTheEndMarker: the same user text survives a
// revoke as survives a rewrite, so the user's notes outlive the note.
func TestRevokeKeepsUserTextAfterTheEndMarker(t *testing.T) {
	env, _ := testEnv(t)
	tool, err := toolByName("claude")
	if err != nil {
		t.Fatal(err)
	}
	if err := tool.Connect(env); err != nil {
		t.Fatal(err)
	}
	path, _ := tool.SkillPath(env)
	writeFile(t, path, readFile(t, path)+"\n## My notes\n\nkeep me on revoke\n")
	if err := tool.Revoke(env); err != nil {
		t.Fatal(err)
	}
	if got := readFile(t, path); !strings.Contains(got, "keep me on revoke") {
		t.Fatalf("revoke lost the user's text after the block:\n%q", got)
	}
}
