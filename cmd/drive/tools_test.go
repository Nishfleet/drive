package main

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// recordingRunner records every command the adapters run instead of executing
// it, so the tests assert the exact command each tool gets. respond, when set,
// answers per call; otherwise fail (when set) answers every call.
type recordingRunner struct {
	calls   []string
	out     string
	fail    error
	respond func(callIndex int, cmd string) ([]byte, error)
}

func (r *recordingRunner) Run(name string, args ...string) ([]byte, error) {
	cmd := strings.TrimSuffix(name+" "+strings.Join(args, " "), " ")
	r.calls = append(r.calls, cmd)
	if r.respond != nil {
		return r.respond(len(r.calls)-1, cmd)
	}
	if r.fail != nil {
		return []byte(r.out), r.fail
	}
	return []byte(r.out), nil
}

func testEnv(t *testing.T) (Env, *recordingRunner) {
	t.Helper()
	runner := &recordingRunner{}
	env := Env{
		Home:     t.TempDir(),
		Runner:   runner,
		LookPath: func(string) (string, error) { return "/fake/bin", nil },
	}.withDefaults()
	return env, runner
}

func TestClaudeConnectRunsItsOwnAddWithUserScope(t *testing.T) {
	env, runner := testEnv(t)
	tool, err := toolByName("claude")
	if err != nil {
		t.Fatal(err)
	}
	if err := tool.Connect(env); err != nil {
		t.Fatal(err)
	}
	want := fmt.Sprintf("claude mcp add -s user %s -- npx -y %s %s", serverName, mcpPackage, env.DriveDir)
	if len(runner.calls) != 1 || runner.calls[0] != want {
		t.Fatalf("Connect ran %q, want %q", runner.calls, want)
	}
}

func TestCodexConnectNeedsItsDoubleDash(t *testing.T) {
	env, runner := testEnv(t)
	tool, err := toolByName("codex")
	if err != nil {
		t.Fatal(err)
	}
	if err := tool.Connect(env); err != nil {
		t.Fatal(err)
	}
	want := fmt.Sprintf("codex mcp add %s -- npx -y %s %s", serverName, mcpPackage, env.DriveDir)
	if len(runner.calls) != 1 || runner.calls[0] != want {
		t.Fatalf("Connect ran %q, want %q", runner.calls, want)
	}
}

func TestGeminiConnectNamesItsTransportAndScope(t *testing.T) {
	env, runner := testEnv(t)
	tool, err := toolByName("gemini")
	if err != nil {
		t.Fatal(err)
	}
	// Gemini's default scope is the project config, which a session elsewhere
	// would not see, and its user scope answers the JSON path check below.
	if err := tool.Connect(env); err != nil {
		t.Fatal(err)
	}
	want := fmt.Sprintf("gemini mcp add -s user -t stdio %s npx -y %s %s", serverName, mcpPackage, env.DriveDir)
	if len(runner.calls) != 1 || runner.calls[0] != want {
		t.Fatalf("Connect ran %q, want %q", runner.calls, want)
	}
}

func TestClaudeReplacesAnExistingEntry(t *testing.T) {
	// The spec requires `drive init` to be safe to run again, but Claude's add
	// refuses an entry that is already there.
	env, runner := testEnv(t)
	tool, err := toolByName("claude")
	if err != nil {
		t.Fatal(err)
	}
	runner.respond = func(i int, cmd string) ([]byte, error) {
		if i == 0 {
			return []byte("MCP server drive already exists in user config"),
				fmt.Errorf("claude mcp add: exit status 1")
		}
		return nil, nil
	}
	if err := tool.Connect(env); err != nil {
		t.Fatal(err)
	}
	want := []string{
		fmt.Sprintf("claude mcp add -s user %s -- npx -y %s %s", serverName, mcpPackage, env.DriveDir),
		fmt.Sprintf("claude mcp remove %s", serverName),
		fmt.Sprintf("claude mcp add -s user %s -- npx -y %s %s", serverName, mcpPackage, env.DriveDir),
	}
	if strings.Join(runner.calls, "\n") != strings.Join(want, "\n") {
		t.Fatalf("ran:\n%s\nwant:\n%s", strings.Join(runner.calls, "\n"), strings.Join(want, "\n"))
	}
}

func TestClaudeReportsAnAddFailureThatIsNotTheKnownConflict(t *testing.T) {
	env, runner := testEnv(t)
	tool, err := toolByName("claude")
	if err != nil {
		t.Fatal(err)
	}
	runner.fail = fmt.Errorf("claude mcp add: exit status 1: something else")
	if err := tool.Connect(env); err == nil {
		t.Fatal("expected the unexpected add failure to be reported")
	}
	if len(runner.calls) != 1 {
		t.Fatalf("a failed add should not touch the existing entry: %q", runner.calls)
	}
}

func TestJSONToolsWriteTheStockServerShape(t *testing.T) {
	env, _ := testEnv(t)
	for _, name := range []string{"cursor", "kiro"} {
		t.Run(name, func(t *testing.T) {
			tool, err := toolByName(name)
			if err != nil {
				t.Fatal(err)
			}
			if err := tool.Connect(env); err != nil {
				t.Fatal(err)
			}
			data, err := os.ReadFile(tool.JSONPath(env.Home))
			if err != nil {
				t.Fatal(err)
			}
			var doc struct {
				MCPServers map[string]struct {
					Command string   `json:"command"`
					Args    []string `json:"args"`
				} `json:"mcpServers"`
			}
			if err := json.Unmarshal(data, &doc); err != nil {
				t.Fatalf("%s: %v", data, err)
			}
			entry, ok := doc.MCPServers[serverName]
			if !ok {
				t.Fatalf("no %s entry under mcpServers:\n%s", serverName, data)
			}
			wantArgs := []string{"-y", mcpPackage, env.DriveDir}
			if entry.Command != "npx" || strings.Join(entry.Args, " ") != strings.Join(wantArgs, " ") {
				t.Fatalf("got %+v, want command npx args %v", entry, wantArgs)
			}
		})
	}
}

func TestJSONConnectKeepsTheUserSOtherServers(t *testing.T) {
	env, _ := testEnv(t)
	tool, err := toolByName("cursor")
	if err != nil {
		t.Fatal(err)
	}
	before := `{"mcpServers":{"other":{"command":"foo"}}}`
	path := tool.JSONPath(env.Home)
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(before), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := tool.Connect(env); err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(data), `"other"`) {
		t.Fatalf("the user's other server was dropped:\n%s", data)
	}
	if !strings.Contains(string(data), `"drive"`) {
		t.Fatalf("drive entry missing:\n%s", data)
	}
}

func TestJSONRevokeRemovesOnlyTheDriveEntry(t *testing.T) {
	env, _ := testEnv(t)
	tool, err := toolByName("cursor")
	if err != nil {
		t.Fatal(err)
	}
	path := tool.JSONPath(env.Home)
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(`{"mcpServers":{"other":{"command":"foo"}}}`), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := tool.Revoke(env); err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(data), serverName) {
		t.Fatalf("drive entry still present:\n%s", data)
	}
	if !strings.Contains(string(data), `"other"`) {
		t.Fatalf("the user's other server was dropped:\n%s", data)
	}
}

func TestJSONRevokeOnAnEmptyDirLeavesNoFile(t *testing.T) {
	env, _ := testEnv(t)
	tool, err := toolByName("cursor")
	if err != nil {
		t.Fatal(err)
	}
	if err := tool.Revoke(env); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(tool.JSONPath(env.Home)); !os.IsNotExist(err) {
		t.Fatalf("revoke created a config file: %v", err)
	}
}

func TestConnectedReadsTheJSONState(t *testing.T) {
	env, _ := testEnv(t)
	tool, err := toolByName("cursor")
	if err != nil {
		t.Fatal(err)
	}
	if yes, err := tool.Connected(env); yes || err != nil {
		t.Fatalf("empty machine reported connected=%v err=%v", yes, err)
	}
	if err := tool.Connect(env); err != nil {
		t.Fatal(err)
	}
	if yes, err := tool.Connected(env); err != nil || !yes {
		t.Fatalf("after connect, connected=%v err=%v", yes, err)
	}
	if err := tool.Revoke(env); err != nil {
		t.Fatal(err)
	}
	if yes, err := tool.Connected(env); err != nil || yes {
		t.Fatalf("after revoke, connected=%v err=%v", yes, err)
	}
}

func TestCheckProbeMeansTheToolAnswersForItself(t *testing.T) {
	env, runner := testEnv(t)
	tool, err := toolByName("claude")
	if err != nil {
		t.Fatal(err)
	}
	// A failed probe is the tool's own "no such server" answer.
	runner.out, runner.fail = "", fmt.Errorf("claude mcp get drive: exit 1: not found")
	if yes, err := tool.Connected(env); yes || err != nil {
		t.Fatalf("failed probe reported connected=%v err=%v", yes, err)
	}
	runner.out = "drive: found"
	runner.fail = nil
	if yes, err := tool.Connected(env); err != nil || !yes {
		t.Fatalf("probe with the server reported connected=%v err=%v", yes, err)
	}
	if len(runner.calls) != 2 || runner.calls[0] != "claude mcp get drive" {
		t.Fatalf("probe ran %q", runner.calls)
	}
}

func TestConnectIdempotentForJSONTools(t *testing.T) {
	env, _ := testEnv(t)
	tool, err := toolByName("cursor")
	if err != nil {
		t.Fatal(err)
	}
	if err := tool.Connect(env); err != nil {
		t.Fatal(err)
	}
	first, err := os.ReadFile(tool.JSONPath(env.Home))
	if err != nil {
		t.Fatal(err)
	}
	if err := tool.Connect(env); err != nil {
		t.Fatal(err)
	}
	second, err := os.ReadFile(tool.JSONPath(env.Home))
	if err != nil {
		t.Fatal(err)
	}
	if string(first) != string(second) {
		t.Fatalf("second connect changed the file:\n%s\n%s", first, second)
	}
}

func TestUnknownToolNamesTheKnownOnes(t *testing.T) {
	_, err := toolByName("not-a-tool")
	if err == nil {
		t.Fatal("expected an error for an unknown tool")
	}
	for _, want := range toolNames() {
		if !strings.Contains(err.Error(), want) {
			t.Errorf("error %q does not name %q", err, want)
		}
	}
}

func TestInitConnectsOnlyInstalledTools(t *testing.T) {
	runner := &recordingRunner{}
	env := Env{
		Home:   t.TempDir(),
		Runner: runner,
		LookPath: func(name string) (string, error) {
			if name == "claude" {
				return "/fake/claude", nil
			}
			return "", fmt.Errorf("not on PATH")
		},
	}.withDefaults()
	if err := initAgents(env); err != nil {
		t.Fatal(err)
	}
	ran := strings.Join(runner.calls, "\n")
	if !strings.Contains(ran, "mcp add") {
		t.Errorf("no connect command ran:\n%s", ran)
	}
	for _, absent := range []string{"codex ", "gemini ", "kiro "} {
		if strings.Contains(ran, absent) {
			t.Errorf("a tool that is not installed was connected:\n%s", ran)
		}
	}
}

func TestInstalledFindsAConfigDirWithoutABinary(t *testing.T) {
	env, _ := testEnv(t)
	env.LookPath = func(string) (string, error) { return "", fmt.Errorf("not on PATH") }
	if err := os.MkdirAll(filepath.Join(env.Home, ".cursor"), 0o700); err != nil {
		t.Fatal(err)
	}
	tool, err := toolByName("cursor")
	if err != nil {
		t.Fatal(err)
	}
	yes, where := tool.Installed(env)
	if !yes {
		t.Fatal("cursor not found via its config dir")
	}
	if filepath.Base(where) != ".cursor" {
		t.Fatalf("found %q, want the .cursor dir", where)
	}
}

func TestAgentsConnectRefusesAnUninstalledTool(t *testing.T) {
	env, runner := testEnv(t)
	env.LookPath = func(string) (string, error) { return "", fmt.Errorf("not on PATH") }
	if err := agents(env, []string{"connect", "cursor"}); err == nil {
		t.Fatal("expected an error connecting a tool that is not installed")
	} else if !strings.Contains(err.Error(), "not installed") {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(runner.calls) != 0 {
		t.Fatalf("a refused connect still ran a command: %q", runner.calls)
	}
}

func TestRunAgentsRejectsAnUnknownTool(t *testing.T) {
	env, runner := testEnv(t)
	if err := agents(env, []string{"connect", "not-a-tool"}); err == nil {
		t.Fatal("expected an error for an unknown tool")
	}
	if len(runner.calls) != 0 {
		t.Fatalf("nothing should run for an unknown tool: %q", runner.calls)
	}
}

func TestHomeFlagIsAcceptedOnEitherSideOfTheToolName(t *testing.T) {
	// `drive agents connect claude --home /x` must work: Go's flag package
	// stops at the first positional, so runAgents reads the flag itself. An
	// unknown tool is used so the parse is exercised without running a real
	// agent tool.
	for _, args := range [][]string{
		{"connect", "not-a-tool", "--home", "/x"},
		{"--home", "/x", "connect", "not-a-tool"},
	} {
		err := runAgents(args)
		if err == nil {
			t.Fatalf("%v: expected an unknown-tool error", args)
		}
		if !strings.Contains(err.Error(), "not-a-tool") || !strings.Contains(err.Error(), "no agent tool named") {
			t.Fatalf("%v: got %v, want an unknown-tool error", args, err)
		}
	}
}

func TestDriveDirDefaultsToTheHome(t *testing.T) {
	env := Env{Home: "/h"}.withDefaults()
	if env.DriveDir != filepath.Join("/h", "Drive") {
		t.Fatalf("DriveDir = %q", env.DriveDir)
	}
}

func TestEnvironWithHomeKeepsExactlyOneHome(t *testing.T) {
	env := []string{"PATH=/bin", "HOME=/real", "LANG=C"}
	got := environWithHome(env, "/fresh")
	homes := 0
	for _, kv := range got {
		if strings.HasPrefix(kv, "HOME=") {
			homes++
			if kv != "HOME=/fresh" {
				t.Fatalf("HOME entry = %q, want HOME=/fresh", kv)
			}
		}
	}
	if homes != 1 {
		t.Fatalf("got %d HOME entries, want exactly 1: %v", homes, got)
	}
	for _, keep := range []string{"PATH=/bin", "LANG=C"} {
		found := false
		for _, kv := range got {
			if kv == keep {
				found = true
			}
		}
		if !found {
			t.Fatalf("dropped unrelated env %q: %v", keep, got)
		}
	}
}

func TestDefaultRunnerCarriesTheEnvHome(t *testing.T) {
	// --home must reach the agent tools too: they write their MCP config under
	// $HOME, so the clean-machine proof would otherwise touch the real user's
	// config (seen on this host 2026-09-30).
	env := Env{Home: "/fresh"}.withDefaults()
	runner, ok := env.Runner.(ExecRunner)
	if !ok {
		t.Fatalf("default Runner is %T, want ExecRunner", env.Runner)
	}
	if runner.Home != "/fresh" {
		t.Fatalf("ExecRunner.Home = %q, want /fresh", runner.Home)
	}
}

func TestConnectCreatesTheDriveFolderBeforeRegistering(t *testing.T) {
	// The MCP filesystem server refuses a folder that does not exist, and the
	// tools run it on registration: claude reported "Failed to connect"
	// against a missing folder (seen on this host 2026-09-30).
	env, runner := testEnv(t)
	existedAtCall := false
	runner.respond = func(_ int, _ string) ([]byte, error) {
		if st, err := os.Stat(env.DriveDir); err == nil && st.IsDir() {
			existedAtCall = true
		}
		return nil, nil
	}
	tool, err := toolByName("claude")
	if err != nil {
		t.Fatal(err)
	}
	if err := tool.Connect(env); err != nil {
		t.Fatal(err)
	}
	if !existedAtCall {
		t.Fatalf("the drive folder did not exist when the tool was registered")
	}
}

func TestConnectCreatesTheDriveFolderForJSONTools(t *testing.T) {
	env, _ := testEnv(t)
	tool, err := toolByName("kiro")
	if err != nil {
		t.Fatal(err)
	}
	if err := tool.Connect(env); err != nil {
		t.Fatal(err)
	}
	if st, err := os.Stat(env.DriveDir); err != nil || !st.IsDir() {
		t.Fatalf("the drive folder was not created: %v", err)
	}
}
