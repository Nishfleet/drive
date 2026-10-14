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
	Home string
}

// ExecRunner runs the real command.
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

// Env is what a tool adapter needs.
type Env struct {
	Home     string
	DriveDir string
	AgentDir string
	Runner   Runner
	LookPath func(string) (string, error)
	Minter   KeyMinter
}

// KeyMinter mints one storage key for one agent tool, server-side.
type KeyMinter interface {
	MintKey(kind, name string) (MintedKey, error)
	RevokeKey(keyID string) error
	RenewKey(keyID string) (RenewedKey, error)
}

const agentKeyEnv = "DRIVE"

func (e Env) withDefaults() Env {
	if e.Runner == nil {
		e.Runner = ExecRunner{Home: e.Home}
	}
	if e.LookPath == nil {
		e.LookPath = exec.LookPath
	}
	if e.DriveDir == "" {
		e.DriveDir = DefaultMountDir(e.Home)
	}
	if e.AgentDir == "" {
		e.AgentDir = e.DriveDir
	}
	return e
}

// Tool is one agent tool's adapter.
type Tool struct {
	Name        string
	Binaries    []string
	ConfigDirs  []string
	Add         []string
	KeyEnv      string
	Check       []string
	Remove      []string
	AddConflict string
	JSONPath    func(home string) string
	Access      func(env Env) error
}

func tools() []Tool {
	return []Tool{
		{
			Name:        "claude",
			Binaries:    []string{"claude"},
			Add:         []string{"mcp", "add", "-s", "user", "{name}", "-e", "{key}", "--", "npx", "-y", mcpPackage, "{dir}"},
			AddConflict: "already exists",
			Check:       []string{"mcp", "get", "{name}"},
			Remove:      []string{"mcp", "remove", "{name}"},
			KeyEnv:      agentKeyEnv,
			Access:      accessClaude,
		},
		{
			Name:     "codex",
			Binaries: []string{"codex"},
			Add:      []string{"mcp", "add", "--env", "{key}", "{name}", "--", "npx", "-y", mcpPackage, "{dir}"},
			Check:    []string{"mcp", "get", "{name}", "--json"},
			Remove:   []string{"mcp", "remove", "{name}"},
			KeyEnv:   agentKeyEnv,
			Access:   func(env Env) error { return writeNote(env, "AGENTS.md") },
		},
		{
			Name:     "gemini",
			Binaries: []string{"gemini"},
			Add:      []string{"mcp", "add", "-s", "user", "-t", "stdio", "-e", "{key}", "{name}", "npx", "-y", mcpPackage, "{dir}"},
			Remove:   []string{"mcp", "remove", "-s", "user", "{name}"},
			KeyEnv:   agentKeyEnv,
			JSONPath: func(home string) string { return filepath.Join(home, ".gemini", "settings.json") },
		},
		{
			Name:       "cursor",
			Binaries:   []string{"cursor"},
			ConfigDirs: []string{".cursor"},
			JSONPath:   func(home string) string { return filepath.Join(home, ".cursor", "mcp.json") },
			KeyEnv:     agentKeyEnv,
			Access:     func(env Env) error { return writeNote(env, "AGENTS.md") },
		},
		{
			Name:       "kiro",
			Binaries:   []string{"kiro"},
			ConfigDirs: []string{".kiro"},
			JSONPath:   func(home string) string { return filepath.Join(home, ".kiro", "settings", "mcp.json") },
			KeyEnv:     agentKeyEnv,
		},
	}
}

func toolByName(name string) (Tool, error) {
	for _, t := range tools() {
		if t.Name == name {
			return t, nil
		}
	}
	return Tool{}, failf("unknown-tool", name, strings.Join(toolNames(), ", "))
}

func toolNames() []string {
	all := tools()
	names := make([]string, 0, len(all))
	for _, t := range all {
		names = append(names, t.Name)
	}
	return names
}

func (t Tool) connectKey(env Env) (string, error) {
	if t.KeyEnv == "" || env.Minter == nil {
		return "", nil
	}
	key, err := agentKeyFor(env.Home, t.Name)
	if err != nil {
		return "", err
	}
	if key == nil {
		return "", nil
	}
	return keyEnvArg(t.KeyEnv, *key), nil
}

func keyEnvArg(prefix string, key agentKey) string {
	return prefix + "_ACCESS_KEY_ID=" + key.AccessKeyID + " " +
		prefix + "_SECRET_ACCESS_KEY=" + key.Secret
}

func expand(args []string, driveDir, key string) []string {
	out := make([]string, 0, len(args))
	for i := 0; i < len(args); i++ {
		a := args[i]
		if key == "" && (a == "-e" || a == "--env") {
			i++
			continue
		}
		a = strings.ReplaceAll(a, "{dir}", driveDir)
		a = strings.ReplaceAll(a, "{name}", serverName)
		a = strings.ReplaceAll(a, "{key}", key)
		out = append(out, a)
	}
	return out
}

// Installed reports whether the tool is on this machine, and where it was found (the binary path, or the config directory).
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

// Connect registers the stock MCP filesystem server for this tool.
func (t Tool) Connect(env Env) error {
	env = env.withDefaults()
	if _, err := env.LookPath("npx"); err != nil {
		return fail("no-node")
	}
	keyArg, err := t.connectKey(env)
	if err != nil {
		return err
	}
	if err := os.MkdirAll(env.AgentDir, 0o755); err != nil {
		return failDetail("drive-folder", err, env.AgentDir)
	}
	if path, ok := t.SkillPath(env); ok {
		if err := writeSkill(env, t, path); err != nil {
			return fmt.Errorf("write the %s skill note: %w", t.Name, err)
		}
	}
	if t.Add != nil {
		if err := t.runAdd(env, keyArg); err != nil {
			return fmt.Errorf("connect %s: %w", t.Name, err)
		}
	} else if err := t.writeJSON(env, true, keyArg); err != nil {
		return fmt.Errorf("connect %s: %w", t.Name, err)
	}
	if t.Access != nil {
		if err := t.Access(env); err != nil {
			return fmt.Errorf("grant %s access to the drive: %w", t.Name, err)
		}
	}
	return nil
}

func (t Tool) runAdd(env Env, keyArg string) error {
	argv := expand(t.Add, env.AgentDir, keyArg)
	out, err := env.Runner.Run(t.Name, argv...)
	if err == nil {
		return nil
	}
	if t.AddConflict == "" || !strings.Contains(string(out), t.AddConflict) {
		return err
	}
	if _, err := env.Runner.Run(t.Name, expand(t.Remove, env.DriveDir, "")...); err != nil {
		return fmt.Errorf("replace the existing entry: %w", err)
	}
	if _, err := env.Runner.Run(t.Name, argv...); err != nil {
		return err
	}
	return nil
}

// Revoke removes the drive's server registration.
func (t Tool) Revoke(env Env) error {
	env = env.withDefaults()
	if t.Remove != nil {
		if _, err := env.Runner.Run(t.Name, expand(t.Remove, env.DriveDir, "")...); err != nil {
			return fmt.Errorf("revoke %s: %w", t.Name, err)
		}
	} else if err := t.writeJSON(env, false, ""); err != nil {
		return fmt.Errorf("revoke %s: %w", t.Name, err)
	}
	if path, ok := t.SkillPath(env); ok {
		if err := revokeSkill(env, t, path); err != nil {
			return fmt.Errorf("remove the %s skill note: %w", t.Name, err)
		}
	}
	return nil
}

// Connected reports whether the drive's server is registered with this tool.
func (t Tool) Connected(env Env) (bool, error) {
	env = env.withDefaults()
	if t.Check != nil {
		out, err := env.Runner.Run(t.Name, expand(t.Check, env.DriveDir, "")...)
		if err != nil {
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

func serverEntry(t Tool, env Env, keyArg string) (map[string]any, error) {
	entry := map[string]any{
		"command": "npx",
		"args":    []string{"-y", mcpPackage, env.AgentDir},
	}
	if t.KeyEnv == "" || keyArg == "" {
		return entry, nil
	}
	vars, err := keyEnv(t.KeyEnv, keyArg)
	if err != nil {
		return nil, err
	}
	entry["env"] = vars
	return entry, nil
}

func keyEnv(prefix, arg string) (map[string]any, error) {
	vars := map[string]any{}
	for _, pair := range strings.Fields(arg) {
		name, value, found := strings.Cut(pair, "=")
		if !found || name == "" || value == "" {
			return nil, fmt.Errorf("the %s key argument %q is not NAME=VALUE", prefix, pair)
		}
		vars[name] = value
	}
	if len(vars) == 0 {
		return nil, fmt.Errorf("the %s key argument is empty", prefix)
	}
	return vars, nil
}

func (t Tool) writeJSON(env Env, connect bool, keyArg string) error {
	path := t.JSONPath(env.Home)
	doc, err := t.readConfig(env)
	if err != nil {
		return err
	}
	if !connect {
		if _, ok := doc["mcpServers"]; !ok {
			return nil
		}
	}
	table, err := serverTable(doc, connect)
	if err != nil {
		return fmt.Errorf("%s: %w", path, err)
	}
	if connect {
		entry, err := serverEntry(t, env, keyArg)
		if err != nil {
			return fmt.Errorf("%s: %w", path, err)
		}
		table[serverName] = entry
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
