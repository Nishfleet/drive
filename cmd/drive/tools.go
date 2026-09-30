package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
)

// serverName is the MCP server name the drive registers in every agent tool,
// and mcpPackage is the stock MCP filesystem server it points at the mount
// (docs/build-spec.md, "Agent tools"). The server talks to the drive folder,
// so every tool sees the same files. `npx -y` needs no global install.
const (
	serverName = "drive"
	mcpPackage = "@modelcontextprotocol/server-filesystem"
)

// Runner runs one external command and returns its combined output.
type Runner interface {
	Run(name string, args ...string) ([]byte, error)
}

// ExecRunner runs the real command.
type ExecRunner struct{}

func (ExecRunner) Run(name string, args ...string) ([]byte, error) {
	out, err := exec.Command(name, args...).CombinedOutput()
	if err != nil {
		return out, fmt.Errorf("%s %s: %w: %s", name, strings.Join(args, " "),
			err, strings.TrimSpace(string(out)))
	}
	return out, nil
}

// Env is what a tool adapter needs. Runner and LookPath are injectable so the
// adapters are tested without an agent tool installed.
type Env struct {
	Home     string
	DriveDir string
	Runner   Runner
	LookPath func(string) (string, error)
}

func (e Env) withDefaults() Env {
	if e.Runner == nil {
		e.Runner = ExecRunner{}
	}
	if e.LookPath == nil {
		e.LookPath = exec.LookPath
	}
	if e.DriveDir == "" {
		e.DriveDir = filepath.Join(e.Home, "Drive")
	}
	return e
}

// Tool is one agent tool's adapter. The drive connects a tool with the tool's
// own mechanism, verified against its current docs on 2026-09-30:
//
//	claude   `claude mcp add [options] <name> <commandOrUrl> [args...]`, with
//	         `-s, --scope <local|project|user>` (default local)
//	codex    `codex mcp add [OPTIONS] <NAME> (--url <URL> | -- <COMMAND>...)`
//	         (codex-rs/cli/src/mcp_cmd.rs); servers live in ~/.codex/config.toml
//	gemini   `gemini mcp add [options] <name> <commandOrUrl> [args...]`, with
//	         `-s, --scope <project|user>` (default project); user servers live
//	         in ~/.gemini/settings.json under `mcpServers`
//	cursor   entry in ~/.cursor/mcp.json under `mcpServers`
//	kiro     entry in ~/.kiro/settings/mcp.json under `mcpServers`
//
// `-s user` (claude, gemini) matters: the default scope is per-project, and a
// fresh session in any project has to see the drive.
type Tool struct {
	// Name is also the binary the CLI tools run.
	Name string
	// Binaries are the executables that mean the tool is installed.
	Binaries []string
	// ConfigDirs mean installed when the tool has no binary on PATH.
	ConfigDirs []string
	// Add is the argv after the binary that connects the drive; {dir} becomes
	// the drive folder and {name} the server name. nil means a JSON tool.
	Add []string
	// Check is the argv after the binary that reports whether the drive is
	// connected: exit 0 with output naming the server means connected, and a
	// non-zero exit is the tool's own "no such server" answer. nil means the
	// state comes from JSONPath instead.
	Check []string
	// Remove is the argv after the binary that disconnects the drive.
	Remove []string
	// JSONPath is the config file of a tool connected through JSON.
	JSONPath func(home string) string
}

// tools is the agent-tool registry. One row per tool the spec commits to.
func tools() []Tool {
	return []Tool{
		{
			Name:     "claude",
			Binaries: []string{"claude"},
			Add:      []string{"mcp", "add", "-s", "user", "{name}", "--", "npx", "-y", mcpPackage, "{dir}"},
			Check:    []string{"mcp", "get", "{name}"},
			Remove:   []string{"mcp", "remove", "{name}"},
		},
		{
			Name:     "codex",
			Binaries: []string{"codex"},
			Add:      []string{"mcp", "add", "{name}", "--", "npx", "-y", mcpPackage, "{dir}"},
			Check:    []string{"mcp", "get", "{name}", "--json"},
			Remove:   []string{"mcp", "remove", "{name}"},
		},
		{
			Name:     "gemini",
			Binaries: []string{"gemini"},
			Add:      []string{"mcp", "add", "-s", "user", "{name}", "npx", "-y", mcpPackage, "{dir}"},
			Remove:   []string{"mcp", "remove", "{name}"},
			JSONPath: func(home string) string { return filepath.Join(home, ".gemini", "settings.json") },
		},
		{
			Name:       "cursor",
			Binaries:   []string{"cursor"},
			ConfigDirs: []string{".cursor"},
			JSONPath:   func(home string) string { return filepath.Join(home, ".cursor", "mcp.json") },
		},
		{
			Name:       "kiro",
			Binaries:   []string{"kiro"},
			ConfigDirs: []string{".kiro"},
			JSONPath:   func(home string) string { return filepath.Join(home, ".kiro", "settings", "mcp.json") },
		},
	}
}

// toolByName returns the adapter for name, or an error naming what exists.
func toolByName(name string) (Tool, error) {
	for _, t := range tools() {
		if t.Name == name {
			return t, nil
		}
	}
	return Tool{}, fmt.Errorf("unknown tool %q (known: %s)", name, strings.Join(toolNames(), ", "))
}

func toolNames() []string {
	all := tools()
	names := make([]string, 0, len(all))
	for _, t := range all {
		names = append(names, t.Name)
	}
	return names
}

// expand fills the {dir} and {name} placeholders in a tool's argv.
func expand(args []string, driveDir string) []string {
	out := make([]string, len(args))
	for i, a := range args {
		a = strings.ReplaceAll(a, "{dir}", driveDir)
		a = strings.ReplaceAll(a, "{name}", serverName)
		out[i] = a
	}
	return out
}

// Installed reports whether the tool is on this machine, and where it was
// found (the binary path, or the config directory).
func (t Tool) Installed(env Env) (bool, string) {
	for _, b := range t.Binaries {
		if p, err := env.LookPath(b); err == nil {
			return true, p
		}
	}
	for _, d := range t.ConfigDirs {
		p := filepath.Join(env.Home, d)
		if st, err := os.Stat(p); err == nil && st.IsDir() {
			return true, p
		}
	}
	return false, ""
}

// Connect registers the stock MCP filesystem server for this tool. Safe to
// run again: the CLI tools replace their own entry, and the JSON merge keeps
// every other server in the file.
func (t Tool) Connect(env Env) error {
	env = env.withDefaults()
	if t.Add != nil {
		if _, err := env.Runner.Run(t.Name, expand(t.Add, env.DriveDir)...); err != nil {
			return fmt.Errorf("connect %s: %w", t.Name, err)
		}
		return nil
	}
	if err := t.writeJSON(env, true); err != nil {
		return fmt.Errorf("connect %s: %w", t.Name, err)
	}
	return nil
}

// Revoke removes the drive's server registration. The storage key for the
// tool is revoked by the api Worker, not here; this only disconnects the tool
// from the local drive folder.
func (t Tool) Revoke(env Env) error {
	env = env.withDefaults()
	if t.Remove != nil {
		if _, err := env.Runner.Run(t.Name, expand(t.Remove, env.DriveDir)...); err != nil {
			return fmt.Errorf("revoke %s: %w", t.Name, err)
		}
		return nil
	}
	if err := t.writeJSON(env, false); err != nil {
		return fmt.Errorf("revoke %s: %w", t.Name, err)
	}
	return nil
}

// Connected reports whether the drive's server is registered with this tool.
func (t Tool) Connected(env Env) (bool, error) {
	env = env.withDefaults()
	if t.Check != nil {
		out, err := env.Runner.Run(t.Name, expand(t.Check, env.DriveDir)...)
		if err != nil {
			// The tool's own "no such server" answer, not a drive failure.
			return false, nil
		}
		return strings.Contains(string(out), serverName), nil
	}
	doc, err := t.readConfig(env)
	if err != nil {
		return false, err
	}
	table, err := serverTable(doc, false)
	if err != nil {
		return false, fmt.Errorf("%s: %w", t.JSONPath(env.Home), err)
	}
	if table == nil {
		return false, nil
	}
	_, ok := table[serverName]
	return ok, nil
}

// readConfig reads the tool's JSON config, returning an empty document when
// the file does not exist yet.
func (t Tool) readConfig(env Env) (map[string]any, error) {
	path := t.JSONPath(env.Home)
	data, err := os.ReadFile(path)
	switch {
	case err == nil:
	case errors.Is(err, fs.ErrNotExist):
		return map[string]any{}, nil
	default:
		return nil, fmt.Errorf("read %s: %w", path, err)
	}
	doc := map[string]any{}
	if len(bytes.TrimSpace(data)) == 0 {
		return doc, nil
	}
	if err := json.Unmarshal(data, &doc); err != nil {
		return nil, fmt.Errorf("%s is not valid JSON: %w", path, err)
	}
	return doc, nil
}

// serverTable returns a document's mcpServers table, creating it when create
// is true. A nil table with nil error means there is no table and none was
// asked for.
func serverTable(doc map[string]any, create bool) (map[string]any, error) {
	raw, ok := doc["mcpServers"]
	if !ok || raw == nil {
		if !create {
			return nil, nil
		}
		table := map[string]any{}
		doc["mcpServers"] = table
		return table, nil
	}
	table, ok := raw.(map[string]any)
	if !ok {
		return nil, fmt.Errorf(`"mcpServers" is not a JSON object`)
	}
	return table, nil
}

// serverEntry is the stock MCP stdio server shape: the command and its args,
// and nothing else. Every JSON-config tool in the registry reads this shape.
func serverEntry(driveDir string) map[string]any {
	return map[string]any{
		"command": "npx",
		"args":    []string{"-y", mcpPackage, driveDir},
	}
}

// writeJSON merges (connect) or removes (revoke) the drive's server in the
// tool's JSON config. Every other key in the file is preserved, because these
// files hold the user's other settings too. An absent file is created on
// connect and stays absent on revoke.
func (t Tool) writeJSON(env Env, connect bool) error {
	path := t.JSONPath(env.Home)
	doc, err := t.readConfig(env)
	if err != nil {
		return err
	}
	if !connect {
		if _, ok := doc["mcpServers"]; !ok {
			return nil // nothing to remove, and no file to touch
		}
	}
	table, err := serverTable(doc, connect)
	if err != nil {
		return fmt.Errorf("%s: %w", path, err)
	}
	if connect {
		table[serverName] = serverEntry(env.DriveDir)
	} else {
		delete(table, serverName)
	}
	out, err := json.MarshalIndent(doc, "", "  ")
	if err != nil {
		return fmt.Errorf("encode %s: %w", path, err)
	}
	out = append(out, '\n')
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return fmt.Errorf("create dir for %s: %w", path, err)
	}
	// Atomic write, 0600: the config names commands the tool will run, and a
	// torn write would leave the tool with half a file.
	tmp, err := os.CreateTemp(filepath.Dir(path), ".drive-mcp-*")
	if err != nil {
		return fmt.Errorf("temp file for %s: %w", path, err)
	}
	tmpName := tmp.Name()
	defer os.Remove(tmpName)
	if _, err := tmp.Write(out); err != nil {
		tmp.Close()
		return fmt.Errorf("write %s: %w", path, err)
	}
	if err := tmp.Close(); err != nil {
		return fmt.Errorf("close %s: %w", path, err)
	}
	if err := os.Chmod(tmpName, 0o600); err != nil {
		return fmt.Errorf("chmod %s: %w", path, err)
	}
	if err := os.Rename(tmpName, path); err != nil {
		return fmt.Errorf("rename into place %s: %w", path, err)
	}
	return nil
}
