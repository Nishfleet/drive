package main

import (
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
)

// The skill note is the drive's instruction file in a location the tool reads
// outside the drive folder, so a session that does not start in the drive
// still learns what the drive is. The in-folder CLAUDE.md / AGENTS.md notes
// (writeNote, access.go) only load when the session opens the drive folder;
// each tool's skill mechanism loads everywhere. Checked against each tool's
// current docs on 2026-09-30:
//
//	claude  personal skill, ~/.claude/skills/<name>/SKILL.md ("Personal:
//	        ~/.claude/skills/<skill-name>/SKILL.md — All your projects on this
//	        machine", code.claude.com/docs/en/skills)
//	codex   user skill, ~/.agents/skills/<name>/SKILL.md ("$HOME/.agents/skills
//	        — Any skills checked into the user's personal folder",
//	        developers.openai.com/codex/skills)
//	gemini  user skill, ~/.gemini/skills/<name>/SKILL.md ("User skills:
//	        Located in ~/.gemini/skills/ or the ~/.agents/skills/ alias",
//	        Gemini CLI docs, Agent Skills)
//	cursor  user-level skill, ~/.cursor/skills/<name>/SKILL.md ("~/.cursor/
//	        skills — User-level (global) on the local machine",
//	        cursor.com/docs/context/skills)
//	kiro    global steering file, ~/.kiro/steering/<name>.md ("Global steering
//	        files reside in your home directory under ~/.kiro/steering/, and
//	        apply to all workspaces", kiro.dev/docs/steering)
//
// Codex, Cursor and Gemini CLI also read the shared ~/.agents/skills/ alias;
// each tool still gets its own file so `drive agents revoke <tool>` is
// per-tool and a tool's own directory stays the source of truth for it.
const (
	// skillName is the skill directory name for the SKILL.md tools and the
	// steering file stem for Kiro.
	skillName = "drive"
	// skillMarker recognises a skill note the drive wrote, so an update
	// replaces it instead of appending it twice.
	skillMarker = "<!-- drive:skill-note -->"
)

// skillPaths is one skill-file path per tool, keyed by the registry name. A
// missing entry means the tool has no skill location the docs name (none
// today).
var skillPaths = map[string]func(home string) string{
	"claude": func(home string) string {
		return filepath.Join(home, ".claude", "skills", skillName, "SKILL.md")
	},
	"codex": func(home string) string {
		return filepath.Join(home, ".agents", "skills", skillName, "SKILL.md")
	},
	"gemini": func(home string) string {
		return filepath.Join(home, ".gemini", "skills", skillName, "SKILL.md")
	},
	"cursor": func(home string) string {
		return filepath.Join(home, ".cursor", "skills", skillName, "SKILL.md")
	},
	"kiro": func(home string) string {
		return filepath.Join(home, ".kiro", "steering", skillName+".md")
	},
}

// SkillPath returns the file that holds the drive's skill note for a tool. A
// tool without a documented skill location reports ok=false, and no note is
// written.
func (t Tool) SkillPath(env Env) (string, bool) {
	fn, ok := skillPaths[t.Name]
	if !ok {
		return "", false
	}
	return fn(env.Home), true
}

// skillBody is the skill note the drive writes: where the drive is, that
// deletes can be undone, and to branch before large edits (docs/build-spec.md,
// "Agent tools"). A session outside the drive folder learns the drive exists
// here; a session inside it learns the same from the in-folder note.
func skillBody(driveDir string) string {
	return skillMarker + "\n" +
		"# The user's drive\n\n" +
		"The user's drive is `" + driveDir + "`, synced to every device and\n" +
		"agent. The `drive` MCP server (name `drive`, the stock filesystem\n" +
		"server over that folder) reads and writes it. The server is allowed\n" +
		"to serve the session's working directory, so to work on drive files,\n" +
		"start the session in `" + driveDir + "`.\n\n" +
		"- Deletes are recoverable: `drive restore <file>` brings a file back.\n" +
		"- Use `drive branch <folder>` before large edits, and `drive approve`\n" +
		"  when the changes are ready to copy back.\n"
}

// writeSkill writes the drive's skill note to the tool's skill location,
// replacing an earlier drive note and keeping any other content. A file at
// the path that the drive did not write is an error, not a clobber.
func writeSkill(env Env, path string) error {
	data, err := os.ReadFile(path)
	switch {
	case err == nil:
	case errors.Is(err, fs.ErrNotExist):
		data = nil
	default:
		return fmt.Errorf("read %s: %w", path, err)
	}
	text := string(data)
	if text != "" && !strings.Contains(text, skillMarker) {
		return fmt.Errorf("%s exists and was not written by the drive; remove or rename it and run `drive agents connect` again", path)
	}
	body := skillBody(env.DriveDir)
	switch {
	case text == "":
		text = body
	default:
		// Replace the block between the marker and the end of the file: the
		// drive note is always the last section of the file it writes.
		text = text[:strings.Index(text, skillMarker)] + body
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return fmt.Errorf("create dir for %s: %w", path, err)
	}
	if err := os.WriteFile(path, []byte(text), 0o644); err != nil {
		return fmt.Errorf("write %s: %w", path, err)
	}
	return nil
}

// revokeSkill removes the drive's skill note, leaving any other content in
// the file, and removes the skill directory when it is left empty. A missing
// file is already revoked.
func revokeSkill(env Env, path string) error {
	data, err := os.ReadFile(path)
	switch {
	case err == nil:
	case errors.Is(err, fs.ErrNotExist):
		return nil
	default:
		return fmt.Errorf("read %s: %w", path, err)
	}
	text := string(data)
	if !strings.Contains(text, skillMarker) {
		return nil // not the drive's note; never delete a file we do not own
	}
	idx := strings.Index(text, skillMarker)
	kept := strings.TrimRight(text[:idx], "\n")
	switch {
	case strings.TrimSpace(kept) == "":
		if err := os.Remove(path); err != nil {
			return fmt.Errorf("remove %s: %w", path, err)
		}
	default:
		if err := os.WriteFile(path, []byte(kept+"\n"), 0o644); err != nil {
			return fmt.Errorf("write %s: %w", path, err)
		}
	}
	dir := filepath.Dir(path)
	entries, err := os.ReadDir(dir)
	if err != nil {
		return fmt.Errorf("read %s: %w", dir, err)
	}
	if len(entries) == 0 {
		if err := os.Remove(dir); err != nil {
			return fmt.Errorf("remove %s: %w", dir, err)
		}
	}
	return nil
}
