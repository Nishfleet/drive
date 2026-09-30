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
	// skillBegin and skillEnd delimit the drive's own block inside the file.
	// A rewrite replaces only that block, so text the user put after it
	// survives; a file with no complete drive block is a collision, not a
	// clobber.
	skillBegin = "<!-- drive:skill-note:begin -->"
	skillEnd   = "<!-- drive:skill-note:end -->"
)

// skillDescription is the frontmatter description the Agent Skills loaders use
// to decide when the skill is relevant. It must be a single YAML line.
const skillDescription = "Read and write the user's drive folder through the drive MCP server. Use when the user asks about files in their drive, or to list, read, or edit drive files."

// skillHeader is the fixed opening of the drive's skill file. The four
// SKILL.md loaders require YAML frontmatter at the very start with name and
// description (Claude Code skills, Codex skills, Gemini CLI skills, Cursor
// skills); Kiro steering files are plain markdown whose default is "always
// included", which its frontmatter makes explicit.
func skillHeader(toolName string) string {
	if toolName == "kiro" {
		return "---\ninclusion: always\n---\n"
	}
	return "---\nname: " + skillName + "\ndescription: " + skillDescription + "\n---\n"
}

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

// skillBody is the drive's block: where the drive is, that deletes can be
// undone, and to branch before large edits (docs/build-spec.md, "Agent
// tools"). A session outside the drive folder learns the drive exists here; a
// session inside it learns the same from the in-folder note.
func skillBody(driveDir string) string {
	return "# The user's drive\n\n" +
		"The user's drive is `" + driveDir + "`, synced to every device and\n" +
		"agent. The `drive` MCP server (name `drive`, the stock filesystem\n" +
		"server over that folder) reads and writes it. The server is allowed\n" +
		"to serve the session's working directory, so to work on drive files,\n" +
		"start the session in `" + driveDir + "`.\n\n" +
		"- Deletes are recoverable: `drive restore <file>` brings a file back.\n" +
		"- Use `drive branch <folder>` before large edits, and `drive approve`\n" +
		"  when the changes are ready to copy back.\n"
}

// skillBlock is the drive's managed region: the begin marker, the body, and
// the end marker. The header (frontmatter) sits before it, because the
// loaders require frontmatter at the very start of the file.
func skillBlock(driveDir string) string {
	return skillBegin + "\n" + skillBody(driveDir) + skillEnd
}

// planSkill returns the exact text the drive's skill file should hold for this
// tool. It is the write path's whole decision, so a caller can preflight it
// (checkSkill) before changing anything, and writeSkill can apply it.
//
// A file that is not the drive's own note is an error, never a clobber: either
// it lacks the drive header, or it lacks one half of the begin/end pair. Text
// the user appended after the end marker is carried over untouched.
func planSkill(env Env, tool Tool, path string) (string, error) {
	fresh := skillHeader(tool.Name) + skillBlock(env.DriveDir) + "\n"
	data, err := os.ReadFile(path)
	switch {
	case errors.Is(err, fs.ErrNotExist):
		return fresh, nil
	case err != nil:
		return "", fmt.Errorf("read %s: %w", path, err)
	}
	text := string(data)
	if text == fresh {
		return fresh, nil // already exactly this note
	}
	header := skillHeader(tool.Name)
	if !strings.HasPrefix(text, header) {
		return "", collisionError(path)
	}
	begin := strings.Index(text, skillBegin)
	end := strings.Index(text, skillEnd)
	if begin < 0 || end < 0 || end < begin {
		return "", collisionError(path)
	}
	// Replace only the drive's block; keep whatever follows the end marker.
	return text[:begin] + skillBlock(env.DriveDir) + text[end+len(skillEnd):], nil
}

func collisionError(path string) error {
	return fmt.Errorf("%s exists and is not the drive's skill note; remove or rename it and run `drive agents connect` again", path)
}

// checkSkill applies planSkill without writing, so Connect can refuse a
// collision before it registers anything and leaves no half-applied state.
func checkSkill(env Env, tool Tool, path string) error {
	_, err := planSkill(env, tool, path)
	return err
}

// writeSkill writes the drive's skill note to the tool's skill location,
// replacing an earlier drive note. The caller preflights with checkSkill, so a
// failure here is a real filesystem error and is reported, not hidden.
func writeSkill(env Env, tool Tool, path string) error {
	text, err := planSkill(env, tool, path)
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return fmt.Errorf("create dir for %s: %w", path, err)
	}
	if err := os.WriteFile(path, []byte(text), 0o644); err != nil {
		return fmt.Errorf("write %s: %w", path, err)
	}
	return nil
}

// revokeSkill removes the drive's block, leaving any text after it, and
// removes the skill directory when it was the drive's own and is now empty. A
// shared directory (Kiro's ~/.kiro/steering) is never removed. A missing file
// is already revoked.
// revokeSkill removes the drive's note from the tool's skill file, leaving
// any text the user put after the drive's block. The file itself is only
// removed when the drive's frontmatter and block were all it held; the
// directory is only removed when the drive created it (its own
// <skills>/drive) and nothing is left in it. A shared directory (Kiro's
// ~/.kiro/steering) is never removed. A missing file is already revoked.
func revokeSkill(env Env, tool Tool, path string) error {
	data, err := os.ReadFile(path)
	switch {
	case err == nil:
	case errors.Is(err, fs.ErrNotExist):
		return nil
	default:
		return fmt.Errorf("read %s: %w", path, err)
	}
	text := string(data)
	header := skillHeader(tool.Name)
	begin := strings.Index(text, skillBegin)
	end := strings.Index(text, skillEnd)
	if !strings.HasPrefix(text, header) || begin < 0 || end < 0 || end < begin {
		return nil // not the drive's note; never delete a file we do not own
	}
	// Drop the drive's frontmatter and its block, keeping what the user
	// wrote after the block.
	kept := strings.TrimRight(text[end+len(skillEnd):], "\n")
	switch {
	case kept == "":
		if err := os.Remove(path); err != nil {
			return fmt.Errorf("remove %s: %w", path, err)
		}
	default:
		if err := os.WriteFile(path, []byte(kept+"\n"), 0o644); err != nil {
			return fmt.Errorf("write %s: %w", path, err)
		}
	}
	// Only a directory the drive created for its own skill is removed. Kiro's
	// steering directory is shared with the user's other steering files, so it
	// stays even when the drive's file was the last thing in it.
	dir := filepath.Dir(path)
	if filepath.Base(dir) != skillName {
		return nil
	}
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
