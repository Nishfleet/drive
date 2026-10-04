package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func writeFile(t *testing.T, path, content string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
		t.Fatal(err)
	}
}

func readFile(t *testing.T, path string) string {
	t.Helper()
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	return string(data)
}

func TestGrantClaudeDriveAddsTheDriveToUserSettings(t *testing.T) {
	env, _ := testEnv(t)
	// A settings file that already has a permissions block, to prove nothing
	// existing is lost.
	settings := filepath.Join(env.Home, claudeSettingsPath)
	writeFile(t, settings, `{
  "permissions": {
    "defaultMode": "bypassPermissions",
    "additionalDirectories": ["/home/nish/workspaces/tooling/nish-vault"]
  },
  "model": "claude-sonnet-5-5"
}`)
	if err := grantClaudeDrive(env); err != nil {
		t.Fatal(err)
	}
	var doc struct {
		Permissions struct {
			DefaultMode           string   `json:"defaultMode"`
			AdditionalDirectories []string `json:"additionalDirectories"`
		} `json:"permissions"`
		Model string `json:"model"`
	}
	if err := json.Unmarshal([]byte(readFile(t, settings)), &doc); err != nil {
		t.Fatal(err)
	}
	if doc.Permissions.DefaultMode != "bypassPermissions" {
		t.Errorf("existing permission mode was lost: %+v", doc.Permissions)
	}
	if doc.Model != "claude-sonnet-5-5" {
		t.Errorf("existing setting was lost: %+v", doc)
	}
	want := []string{"/home/nish/workspaces/tooling/nish-vault", env.DriveDir}
	if strings.Join(doc.Permissions.AdditionalDirectories, ",") != strings.Join(want, ",") {
		t.Errorf("additionalDirectories = %v, want %v", doc.Permissions.AdditionalDirectories, want)
	}
}

func TestGrantClaudeDriveCreatesMissingSettings(t *testing.T) {
	env, _ := testEnv(t)
	if err := grantClaudeDrive(env); err != nil {
		t.Fatal(err)
	}
	settings := filepath.Join(env.Home, claudeSettingsPath)
	if got := readFile(t, settings); !strings.Contains(got, env.DriveDir) {
		t.Fatalf("settings do not name the drive:\n%s", got)
	}
}

func TestGrantClaudeDriveIsIdempotent(t *testing.T) {
	env, _ := testEnv(t)
	settings := filepath.Join(env.Home, claudeSettingsPath)
	if err := grantClaudeDrive(env); err != nil {
		t.Fatal(err)
	}
	first := readFile(t, settings)
	if err := grantClaudeDrive(env); err != nil {
		t.Fatal(err)
	}
	second := readFile(t, settings)
	if second != first {
		t.Fatalf("a second grant changed the file:\n%s\n%s", first, second)
	}
	if strings.Count(second, env.DriveDir) != 1 {
		t.Fatalf("the drive was granted more than once:\n%s", second)
	}
}

func TestGrantClaudeDriveRefusesABrokenSettingsFile(t *testing.T) {
	env, _ := testEnv(t)
	settings := filepath.Join(env.Home, claudeSettingsPath)
	writeFile(t, settings, "{not json")
	err := grantClaudeDrive(env)
	if err == nil {
		t.Fatal("expected an error on invalid JSON")
	}
	if !strings.Contains(err.Error(), "not valid JSON") {
		t.Fatalf("unexpected error: %v", err)
	}
	if got := readFile(t, settings); got != "{not json" {
		t.Fatalf("the user's file was modified: %s", got)
	}
}

func TestGrantClaudeDriveRefusesAWrongTypedBlock(t *testing.T) {
	env, _ := testEnv(t)
	settings := filepath.Join(env.Home, claudeSettingsPath)
	writeFile(t, settings, `{"permissions": "nope"}`)
	if err := grantClaudeDrive(env); err == nil {
		t.Fatal("expected an error when permissions is not an object")
	}
	writeFile(t, settings, `{"permissions": {"additionalDirectories": "nope"}}`)
	if err := grantClaudeDrive(env); err == nil {
		t.Fatal("expected an error when additionalDirectories is not an array")
	}
}

func TestSettingsFileStaysPrivate(t *testing.T) {
	env, _ := testEnv(t)
	if err := grantClaudeDrive(env); err != nil {
		t.Fatal(err)
	}
	st, err := os.Stat(filepath.Join(env.Home, claudeSettingsPath))
	if err != nil {
		t.Fatal(err)
	}
	if perm := st.Mode().Perm(); perm != 0o600 {
		t.Fatalf("settings mode = %o, want 600 (it can hold secrets)", perm)
	}
}

func TestWriteNoteCreatesTheDriveFolderAndBothNotes(t *testing.T) {
	for _, name := range noteNames {
		t.Run(name, func(t *testing.T) {
			env, _ := testEnv(t)
			if err := writeNote(env, name); err != nil {
				t.Fatal(err)
			}
			text := readFile(t, filepath.Join(env.DriveDir, name))
			for _, want := range []string{env.DriveDir, "drive branch", "drive approve"} {
				if !strings.Contains(text, want) {
					t.Errorf("%s note is missing %q:\n%s", name, want, text)
				}
			}
		})
	}
}

func TestWriteNoteKeepsTheUsersOwnText(t *testing.T) {
	env, _ := testEnv(t)
	path := filepath.Join(env.DriveDir, agentsNoteName)
	writeFile(t, path, "my own house rules")
	if err := writeNote(env, agentsNoteName); err != nil {
		t.Fatal(err)
	}
	text := readFile(t, path)
	if !strings.Contains(text, "my own house rules") {
		t.Fatalf("the user's text was lost:\n%s", text)
	}
	if !strings.Contains(text, noteMarker) {
		t.Fatalf("the drive note is missing:\n%s", text)
	}
}

func TestWriteNoteIsIdempotent(t *testing.T) {
	env, _ := testEnv(t)
	if err := writeNote(env, claudeNoteName); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(env.DriveDir, claudeNoteName)
	first := readFile(t, path)
	if err := writeNote(env, claudeNoteName); err != nil {
		t.Fatal(err)
	}
	if second := readFile(t, path); second != first {
		t.Fatalf("a second write changed the note:\n%s\n%s", first, second)
	}
}

func TestWriteNoteRejectsAnUnknownName(t *testing.T) {
	env, _ := testEnv(t)
	if err := writeNote(env, "README.md"); err == nil {
		t.Fatal("expected an error for a name the drive does not own")
	}
}

func TestConnectFailsLoudlyWhenAccessCannotBeGranted(t *testing.T) {
	env, _ := testEnv(t)
	// A settings file the drive cannot parse: connecting must report it, not
	// leave a registered server the tool cannot reach.
	writeFile(t, filepath.Join(env.Home, claudeSettingsPath), "{broken")
	tool, err := toolByName("claude")
	if err != nil {
		t.Fatal(err)
	}
	err = tool.Connect(env)
	if err == nil {
		t.Fatal("expected an error when the access grant fails")
	}
	if !strings.Contains(err.Error(), "grant claude access") {
		t.Fatalf("unexpected error: %v", err)
	}
}

func TestConnectClaudeWritesBothAccessGrants(t *testing.T) {
	// claude's Access is the only one that must do two things: the settings
	// entry for its built-in file tools, and the CLAUDE.md note a session
	// started in the drive folder reads.
	env, _ := testEnv(t)
	tool, err := toolByName("claude")
	if err != nil {
		t.Fatal(err)
	}
	if err := tool.Connect(env); err != nil {
		t.Fatal(err)
	}
	if got := readFile(t, filepath.Join(env.Home, claudeSettingsPath)); !strings.Contains(got, env.DriveDir) {
		t.Errorf("the drive is not in the claude settings:\n%s", got)
	}
	note := readFile(t, filepath.Join(env.DriveDir, claudeNoteName))
	for _, want := range []string{noteMarker, env.DriveDir, "drive branch", "drive approve"} {
		if !strings.Contains(note, want) {
			t.Errorf("the %s note is missing %q:\n%s", claudeNoteName, want, note)
		}
	}
}

func TestNoteTellsTheAgentToStartInTheDrive(t *testing.T) {
	// The MCP server serves the session's working directory, not the folder on
	// its command line, so the note is the only place a session learns it.
	env, _ := testEnv(t)
	if err := writeNote(env, agentsNoteName); err != nil {
		t.Fatal(err)
	}
	text := readFile(t, filepath.Join(env.DriveDir, agentsNoteName))
	if !strings.Contains(text, "start the\nsession in this folder") {
		t.Fatalf("the note does not tell the agent to start in the drive:\n%s", text)
	}
}
