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

func accessClaude(env Env) error {
	if err := grantClaudeDrive(env); err != nil {
		return err
	}
	return writeNote(env, claudeNoteName)
}

const claudeSettingsPath = ".claude/settings.json"

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

const (
	claudeNoteName = "CLAUDE.md"
	agentsNoteName = "AGENTS.md"
)

var noteNames = []string{claudeNoteName, agentsNoteName}

func writeNote(env Env, name string) error {
	if name != claudeNoteName && name != agentsNoteName {
		return fmt.Errorf("unknown note name %q", name)
	}
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

const noteMarker = "<!-- drive:agent-note -->"

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

func writeJSONObject(path string, doc map[string]any) error {
	out, err := json.MarshalIndent(doc, "", "  ")
	if err != nil {
		return fmt.Errorf("encode %s: %w", path, err)
	}
	out = append(out, '\n')
	return WriteFileAtomic(path, out, 0o600)
}
