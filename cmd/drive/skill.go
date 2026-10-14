package main

import (
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
)

const (
	skillName  = "drive"
	skillBegin = "<!-- drive:skill-note:begin -->"
	skillEnd   = "<!-- drive:skill-note:end -->"
)

const skillDescription = "Read, write and search the user's drive folder through the drive MCP server. Use when the user asks about files in their drive, or to list, search, read, or edit drive files."

func skillHeader(toolName string) string {
	if toolName == "kiro" {
		return "---\ninclusion: always\n---\n"
	}
	return "---\nname: " + skillName + "\ndescription: " + skillDescription + "\n---\n"
}

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

// SkillPath returns the file that holds the drive's skill note for a tool.
func (t Tool) SkillPath(env Env) (string, bool) {
	fn, ok := skillPaths[t.Name]
	if !ok {
		return "", false
	}
	return fn(env.Home), true
}

func skillBody(driveDir string) string {
	return "# The user's drive\n\n" +
		"The user's drive is `" + driveDir + "`, synced to every device and\n" +
		"agent. The `drive` MCP server (name `drive`, the stock filesystem\n" +
		"server over that folder) reads and writes it. The server is allowed\n" +
		"to serve the session's working directory, so to work on drive files,\n" +
		"start the session in `" + driveDir + "`.\n\n" +
		"- To find a file by name, use the `search_files` MCP tool. For the\n" +
		"  fast, index-backed search, run `drive search <words>` in a terminal:\n" +
		"  it answers from the drive's file index and does not walk the folder.\n" +
		"- The folder is not fully on the computer: the parts an app has opened\n" +
		"  sit in a capped cache, and `drive cache --max 5G` sizes it.\n" +
		"- Use `drive branch <folder>` before large edits, and `drive approve`\n" +
		"  when the changes are ready to copy back.\n"
}

func skillBlock(driveDir string) string {
	return skillBegin + "\n" + skillBody(driveDir) + skillEnd
}

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
		return fresh, nil
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
	if strings.Contains(text[end+len(skillEnd):], skillBegin) {
		return "", collisionError(path)
	}
	return text[:begin] + skillBlock(env.DriveDir) + text[end+len(skillEnd):], nil
}

func collisionError(path string) error {
	return fmt.Errorf("%s exists and is not the drive's skill note; remove or rename it and run `drive agents connect` again", path)
}

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
	if !strings.HasPrefix(text, header) {
		return nil
	}
	begin := strings.Index(text, skillBegin)
	end := strings.Index(text, skillEnd)
	if begin < 0 || end < 0 || end < begin {
		return nil
	}
	kept := strings.TrimSpace(text[len(header):begin] + text[end+len(skillEnd):])
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
