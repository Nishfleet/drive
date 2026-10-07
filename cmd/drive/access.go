package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
)

// accessClaude grants Claude Code the folder both ways the tool reads it:
// permissions.additionalDirectories for its built-in file tools, and the
// CLAUDE.md note inside the drive folder so a session started there is told
// what the folder is. Both must succeed; a failure is reported, not hidden.
func accessClaude(env Env) error {
	if err := grantClaudeDrive(env); err != nil {
		return err
	}
	return writeNote(env, claudeNoteName)
}

// claudeSettingsPath is Claude Code's user settings file. `drive init` adds
// the drive folder to permissions.additionalDirectories here, which lets
// Claude's built-in file tools (Bash, Read, Edit) use the drive from any
// working directory. It does not change the MCP filesystem server's roots:
// those are the session's working directories and replace the server's
// arguments entirely, so the drive MCP server only serves sessions started
// inside the drive folder (see grantClaudeDrive below).
const claudeSettingsPath = ".claude/settings.json"

// grantClaudeDrive adds the tool's agent path to Claude Code's user-level
// permissions.additionalDirectories, creating the settings file when absent and
// keeping every existing setting. A previously granted person's Drive folder is
// dropped, because that mount holds the key that can delete (drive#514). It is
// idempotent: a second run changes nothing.
//
// The additionalDirectories setting makes Claude's built-in file tools (Bash,
// Read, Edit) treat the listed directories as allowed. However, it does NOT
// extend the MCP filesystem server's roots: Claude Code's MCP roots are the
// session's working directories and completely replace the server's command-line
// arguments (see the MCP filesystem server docs: Roots protocol replaces Allowed
// directories). This means a Claude Code session started outside the drive
// cannot use the drive MCP server unless started in the drive folder.
//
// To grant MCP-root access, start Claude Code in the drive folder (e.g. cd
// ~/Drive && claude -p). The CLAUDE.md note left in the drive folder instructs
// agents to start there. Without starting in the folder, the MCP server's only
// allowed directory is the cwd.
func grantClaudeDrive(env Env) error {
	path := filepath.Join(env.Home, claudeSettingsPath)
	doc, err := readJSONObject(path)
	if err != nil {
		return err
	}
	perms, err := objectAt(doc, "permissions", true)
	if err != nil {
		return fmt.Errorf("%s: %w", path, err)
	}
	dirs, err := stringArrayAt(perms, "additionalDirectories", true)
	if err != nil {
		return fmt.Errorf("%s permissions.additionalDirectories: %w", path, err)
	}
	folder := env.AgentDir
	if folder == "" {
		folder = env.DriveDir
	}
	out := make([]string, 0, len(dirs)+1)
	seen := false
	for _, d := range dirs {
		if d == env.DriveDir && env.DriveDir != folder {
			continue
		}
		if d == folder {
			seen = true
		}
		out = append(out, d)
	}
	if !seen {
		out = append(out, folder)
	}
	if len(out) == len(dirs) {
		same := true
		for i := range out {
			if out[i] != dirs[i] {
				same = false
				break
			}
		}
		if same {
			return nil
		}
	}
	perms["additionalDirectories"] = out
	return writeJSONObject(path, doc)
}

// noteName is the instruction file the drive leaves inside the drive folder.
// Claude Code reads CLAUDE.md and Cursor reads AGENTS.md, so a session that
// opens the drive as its workspace is told what the folder is.
const (
	claudeNoteName = "CLAUDE.md"
	agentsNoteName = "AGENTS.md"
)

var noteNames = []string{claudeNoteName, agentsNoteName}

// writeNote writes the drive's short instruction file into the drive folder.
// Existing text is kept, so a user's own notes in the folder are not lost.
func writeNote(env Env, name string) error {
	if name != claudeNoteName && name != agentsNoteName {
		return fmt.Errorf("unknown note name %q", name)
	}
	// The note is written into the tool's agent path, the folder the
	// filesystem server is actually given (drive#514).
	if err := os.MkdirAll(env.AgentDir, 0o755); err != nil {
		return fmt.Errorf("create agent path %s: %w", env.AgentDir, err)
	}
	path := filepath.Join(env.AgentDir, name)
	data, err := os.ReadFile(path)
	switch {
	case err == nil:
	case errors.Is(err, fs.ErrNotExist):
		data = nil
	default:
		return fmt.Errorf("read %s: %w", path, err)
	}
	text := string(data)
	if !strings.Contains(text, noteMarker) {
		if text != "" && !strings.HasSuffix(text, "\n") {
			text += "\n"
		}
		text += noteBody(env)
	}
	if err := os.WriteFile(path, []byte(text), 0o644); err != nil {
		return fmt.Errorf("write %s: %w", path, err)
	}
	return nil
}

// noteMarker recognises a note the drive already wrote, so repeated runs do
// not append it twice.
const noteMarker = "<!-- drive:agent-note -->"

// noteBody is the short note left in the drive folder: where the drive is,
// and to branch before large edits. It names only subcommands the command
// table runs (main.go commands; gate test TestNotesNameOnlyRealCommands,
// drive#461) — it used to advertise `drive restore`, which no step ships.
func noteBody(env Env) string {
	return noteMarker + "\n" +
		"# This is the drive\n\n" +
		"The user's drive is `" + env.DriveDir + "`, synced to every device and\n" +
		"agent. The `drive` MCP server reads and writes `" + env.AgentDir + "`, the\n" +
		"folder the mount for this tool serves, so work here, and start the\n" +
		"session in this folder so the server is allowed to serve it.\n\n" +
		"- Use `drive branch <folder>` before large edits, and `drive approve` when\n" +
		"  the changes are ready to copy back.\n"
}

// readJSONObject reads a JSON object file, returning an empty object when the
// file does not exist yet.
func readJSONObject(path string) (map[string]any, error) {
	data, err := os.ReadFile(path)
	switch {
	case err == nil:
	case errors.Is(err, fs.ErrNotExist):
		return map[string]any{}, nil
	default:
		return nil, fmt.Errorf("read %s: %w", path, err)
	}
	doc := map[string]any{}
	if strings.TrimSpace(string(data)) == "" {
		return doc, nil
	}
	if err := json.Unmarshal(data, &doc); err != nil {
		return nil, fmt.Errorf("%s is not valid JSON: %w", path, err)
	}
	return doc, nil
}

// objectAt returns the named nested object, creating it when create is true.
func objectAt(doc map[string]any, key string, create bool) (map[string]any, error) {
	raw, ok := doc[key]
	if !ok || raw == nil {
		if !create {
			return nil, nil
		}
		child := map[string]any{}
		doc[key] = child
		return child, nil
	}
	child, ok := raw.(map[string]any)
	if !ok {
		return nil, fmt.Errorf("%q is not a JSON object", key)
	}
	return child, nil
}

// stringArrayAt returns the named string array, creating it when create is true.
func stringArrayAt(doc map[string]any, key string, create bool) ([]string, error) {
	raw, ok := doc[key]
	if !ok || raw == nil {
		if !create {
			return nil, nil
		}
		return []string{}, nil
	}
	items, ok := raw.([]any)
	if !ok {
		return nil, fmt.Errorf("%q is not a JSON array", key)
	}
	out := make([]string, 0, len(items))
	for _, item := range items {
		s, ok := item.(string)
		if !ok {
			return nil, fmt.Errorf("%q has a non-string entry", key)
		}
		out = append(out, s)
	}
	return out, nil
}

// writeJSONObject writes a JSON object atomically, 0600, with a trailing
// newline. The settings file can hold secrets (env values), so its mode is
// never widened.
func writeJSONObject(path string, doc map[string]any) error {
	out, err := json.MarshalIndent(doc, "", "  ")
	if err != nil {
		return fmt.Errorf("encode %s: %w", path, err)
	}
	out = append(out, '\n')
	return WriteFileAtomic(path, out, 0o600)
}
