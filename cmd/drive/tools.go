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
// and mcpPackage is the stock MCP filesystem server it points at the drive
// folder (docs/build-spec.md, "Agent tools"). The server takes a file lock and
// an allowlist. It also supports MCP Roots, and per its README ("Method 2: MCP
// Roots") roots notified by the client "completely replace any server-side
// Allowed directories when provided". Claude Code sends its session's working
// directories as roots, so a session started outside the drive is served only
// its own cwd, even with the drive folder on the command line. Verified on
// this host 2026-09-30 with claude 2.1.284 and server-filesystem 2026.8.31:
// `list_allowed_directories` returned /tmp for a session started in /tmp and
// the drive folder for one started in the drive. `npx -y` needs no global
// install.
const (
	serverName = "drive"
	mcpPackage = "@modelcontextprotocol/server-filesystem"
)

// Runner runs one external command and returns its combined output.
type Runner interface {
	Run(name string, args ...string) ([]byte, error)
}

// ExecRunner runs the real command.
type ExecRunner struct {
	// Home, when set, is the HOME the child sees. The agent tools keep their
	// MCP config under $HOME, so --home must reach the child too: without it
	// `drive init --home <fresh>` registered the server in the real user's
	// config, and a clean-machine run could not be proven at all (both seen
	// on this host 2026-09-30).
	Home string
}

// ExecRunner runs the real command. name and args are never taken from user
// input: every caller passes a Tool from the tools() registry and argv built
// by expand() from that row. The binary is looked up on PATH (claude, codex,
// gemini), and DriveDir reaches args only as the user's own --home value on
// their own machine. exec.Command takes argv, not a shell, so no argument is
// word-split or interpreted.
func (r ExecRunner) Run(name string, args ...string) ([]byte, error) {
	// nosemgrep: go.lang.security.audit.dangerous-exec-command.dangerous-exec-command -- command comes from the fixed tools() registry, argv from expand(); see the audit above.
	cmd := exec.Command(name, args...)
	if r.Home != "" {
		cmd.Env = environWithHome(os.Environ(), r.Home)
	}
	out, err := cmd.CombinedOutput()
	if err != nil {
		return out, fmt.Errorf("%s %s: %w: %s", name, strings.Join(args, " "),
			err, strings.TrimSpace(string(out)))
	}
	return out, nil
}

// environWithHome returns environ with exactly one HOME entry, its value
// home: existing entries are dropped, the new one is appended (Go passes the
// slice to execve unchanged).
func environWithHome(environ []string, home string) []string {
	out := make([]string, 0, len(environ)+1)
	for _, kv := range environ {
		if strings.HasPrefix(kv, "HOME=") {
			continue
		}
		out = append(out, kv)
	}
	return append(out, "HOME="+home)
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
		e.Runner = ExecRunner{Home: e.Home}
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
//	         `-s, --scope <project|user>` (default project) and
//	         `-t, --transport <stdio|sse|http>`; user servers live in
//	         ~/.gemini/settings.json under `mcpServers`. add overwrites an
//	         existing entry (packages/cli/src/commands/mcp/add.ts), so it is
//	         safe to run again.
//	cursor   entry in its MCP file `~/.cursor/mcp.json` under `mcpServers`;
//	        Cursor reads AGENTS.md (the project root, and scoped AGENTS.md in
//	        subdirectories), so the drive is added as an instruction file once
//	        the mount exists.
//	kiro    entry in `~/.kiro/settings/mcp.json` under `mcpServers`.
//
// claude gets a CLAUDE.md note in the drive folder and the drive added to the
// user setting that lets its built-in file tools use the folder from anywhere;
// codex and cursor get an AGENTS.md note, which is the instruction file they
// read.
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
	// AddConflict is the substring of the tool's own output that means the
	// server is already configured, so Connect may replace it (remove, then
	// add again). Empty when the tool's add already overwrites, as codex and
	// gemini do.
	AddConflict string
	// JSONPath is the config file of a tool connected through JSON.
	JSONPath func(home string) string
	// Access, when set, grants the tool access to the drive folder outside the
	// MCP registration: Claude gets the folder in permissions.additionalDirectories
	// (its built-in file tools), and claude, codex and cursor get an
	// instruction note in the folder so a session opened on the drive knows
	// what it is. Neither reaches the MCP server's roots, which are the
	// session's working directories, so a session must be started in the drive
	// folder to use the drive server.
	Access func(env Env) error
	// Skill names the tool's skill-note file, a personal skill the tool loads
	// in any session on this machine, not only one started in the drive
	// folder. Every tool in the registry has one; see skill.go for each
	// tool's documented path.
	Skill func(t Tool, env Env) (string, bool)
}

// tools is the agent-tool registry. One row per tool the spec commits to.
func tools() []Tool {
	return []Tool{
		{
			Name:        "claude",
			Binaries:    []string{"claude"},
			Add:         []string{"mcp", "add", "-s", "user", "{name}", "--", "npx", "-y", mcpPackage, "{dir}"},
			AddConflict: "already exists",
			Check:       []string{"mcp", "get", "{name}"},
			Remove:      []string{"mcp", "remove", "{name}"},
			Access:      accessClaude,
			Skill:       skillPath,
		},
		{
			Name:     "codex",
			Binaries: []string{"codex"},
			Add:      []string{"mcp", "add", "{name}", "--", "npx", "-y", mcpPackage, "{dir}"},
			Check:    []string{"mcp", "get", "{name}", "--json"},
			Remove:   []string{"mcp", "remove", "{name}"},
			Access:   func(env Env) error { return writeNote(env, "AGENTS.md") },
			Skill:    skillPath,
		},
		{
			Name:     "gemini",
			Binaries: []string{"gemini"},
			Add:      []string{"mcp", "add", "-s", "user", "-t", "stdio", "{name}", "npx", "-y", mcpPackage, "{dir}"},
			Remove:   []string{"mcp", "remove", "-s", "user", "{name}"},
			JSONPath: func(home string) string { return filepath.Join(home, ".gemini", "settings.json") },
			Skill:    skillPath,
		},
		{
			Name:       "cursor",
			Binaries:   []string{"cursor"},
			ConfigDirs: []string{".cursor"},
			JSONPath:   func(home string) string { return filepath.Join(home, ".cursor", "mcp.json") },
			Access:     func(env Env) error { return writeNote(env, "AGENTS.md") },
			Skill:      skillPath,
		},
		{
			Name:       "kiro",
			Binaries:   []string{"kiro"},
			ConfigDirs: []string{".kiro"},
			JSONPath:   func(home string) string { return filepath.Join(home, ".kiro", "settings", "mcp.json") },
			Skill:      skillPath,
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
// run again: the CLI tools replace their own entry (either because their add
// overwrites, or by removing the existing entry first), and the JSON merge
// keeps every other server in the file.
func (t Tool) Connect(env Env) error {
	env = env.withDefaults()
	// The MCP filesystem server refuses to start against a folder that does
	// not exist ("None of the specified directories are accessible"), and the
	// tools run it on registration to report a live status: claude mcp get said
	// "Failed to connect" until the folder existed (seen on this host
	// 2026-09-30). Create it before the tool is pointed at it.
	if err := os.MkdirAll(env.DriveDir, 0o755); err != nil {
		return fmt.Errorf("create drive folder %s: %w", env.DriveDir, err)
	}
	if t.Add != nil {
		if err := t.runAdd(env); err != nil {
			return fmt.Errorf("connect %s: %w", t.Name, err)
		}
	} else if err := t.writeJSON(env, true); err != nil {
		return fmt.Errorf("connect %s: %w", t.Name, err)
	}
	if t.Access != nil {
		if err := t.Access(env); err != nil {
			return fmt.Errorf("grant %s access to the drive: %w", t.Name, err)
		}
	}
	if path, ok := t.Skill(t, env); ok {
		if err := writeSkill(env, path); err != nil {
			return fmt.Errorf("write the %s skill note: %w", t.Name, err)
		}
	}
	return nil
}

// runAdd runs the tool's add command, replacing an existing entry when the
// tool refuses to overwrite one (claude says "already exists in user config").
func (t Tool) runAdd(env Env) error {
	argv := expand(t.Add, env.DriveDir)
	out, err := env.Runner.Run(t.Name, argv...)
	if err == nil {
		return nil
	}
	if t.AddConflict == "" || !strings.Contains(string(out), t.AddConflict) {
		return err // not the known "already configured" answer
	}
	if _, err := env.Runner.Run(t.Name, expand(t.Remove, env.DriveDir)...); err != nil {
		return fmt.Errorf("replace the existing entry: %w", err)
	}
	if _, err := env.Runner.Run(t.Name, argv...); err != nil {
		return err
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
	} else if err := t.writeJSON(env, false); err != nil {
		return fmt.Errorf("revoke %s: %w", t.Name, err)
	}
	// The skill note goes last: a tool that is still registered is more useful
	// with the note than without the registration, so the note is the last
	// thing to disappear.
	if path, ok := t.Skill(t, env); ok {
		if err := revokeSkill(env, path); err != nil {
			return fmt.Errorf("remove the %s skill note: %w", t.Name, err)
		}
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
