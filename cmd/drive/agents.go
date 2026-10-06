package main

import (
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"time"
)

// ToolMinter mints a tool's own agent key through the api Worker (build step
// 4, drive#55) and keeps it where `drive agents revoke` can find it again.
type ToolMinter struct {
	Client *APIClient
	Home   string
}

// MintKey asks the api Worker for a key of this kind and name, then stores it
// 0600 next to the device's rclone config.
func (m ToolMinter) MintKey(kind, name string) (MintedKey, error) {
	key, err := m.Client.MintKey(kind, name)
	if err != nil {
		return MintedKey{}, err
	}
	if err := saveAgentKey(m.Home, name, key); err != nil {
		return MintedKey{}, err
	}
	return key, nil
}

// RevokeKey is the client half, called before the local copy is deleted: a
// key that is refused here is a key that still works server-side.
func (m ToolMinter) RevokeKey(keyID string) error {
	return m.Client.RevokeKey(keyID)
}

// RenewKey restarts the hour on a key this device already holds, and answers
// with the restarted row. It writes the new expiry to disk and changes nothing
// else: the credential is not replaced, so the tool's own MCP entry keeps
// holding the pair that now works again.
func (m ToolMinter) RenewKey(keyID string) (RenewedKey, error) {
	return m.Client.RenewKey(keyID)
}

// runInit is the `drive init` command: the whole first-run setup, in one
// command (drive#105). It registers the same storage flags `drive mount` takes
// plus its own --api, so one command takes a machine from nothing to a mounted
// drive with the agent tools connected.
func runInit(args []string) error {
	fs := flag.NewFlagSet("init", flag.ContinueOnError)
	api := fs.String("api", os.Getenv("DRIVE_API_URL"), "api Worker base URL")
	m := addStorageFlags(fs)
	if err := fs.Parse(args); err != nil {
		return errFlagParse
	}
	if fs.NArg() > 0 {
		return usageFailure(usage, fmt.Sprintf("unexpected argument %q", fs.Arg(0)))
	}
	base, err := resolveAPIBase(m.common.home, *api)
	if err != nil {
		return err
	}
	return initDevice(fs, m, base)
}

// initDevice is the body `drive init` runs: check rclone, write the login item
// that starts the mount at login, mount, then connect every installed agent
// tool. The order is the reason the command exists — rclone is the one
// dependency the machine needs before anything else works, so it is checked
// first and its fix is said in the same breath (drive#105).
//
// `drive uninstall` is the other half of the start-at-login promise: it
// removes the login item this writes, on both platforms.
func initDevice(fs *flag.FlagSet, m *mountFlags, apiBase string) error {
	rclone, c, err := m.resolve(fs)
	if err != nil {
		return err
	}
	if err := CheckRclone(CurrentGOOS(), rclone); err != nil {
		return err
	}
	if err := Mount(CurrentGOOS(), m.common.home, rclone, c, false, false, m.driveLetter); err != nil {
		return err
	}
	return initAgents(Env{Home: m.common.home}.withDefaults(), apiBase)
}

// signedInEnv signs this device in, once, and returns the environment with a
// key minter attached. The device token is kept 0600 in the drive's config
// directory, so a second `drive init` does not make a person approve a code
// again (build-spec.md: "Safe to run again").
func signedInEnv(env Env, apiBase string) (Env, error) {
	// A caller that already supplied a key minter (the tests) is signed in by
	// construction: there is nothing to ask the api Worker for.
	if env.Minter != nil {
		return env, nil
	}
	creds, err := LoadCredentials(env.Home)
	if err != nil {
		return env, err
	}
	base, err := resolveAPIBase(env.Home, apiBase)
	if err != nil {
		return env, err
	}
	if strings.TrimSpace(base) == "" {
		return env, fail("no-api")
	}
	if creds.DeviceToken == "" {
		client, err := NewAPIClient(base, "")
		if err != nil {
			return env, err
		}
		signed, err := SignIn(client, envDeviceName(), os.Stdout)
		if err != nil {
			return env, err
		}
		creds = Credentials{
			APIBase:     client.Base,
			DeviceToken: signed.Token,
			// The sign-in's own expiry, kept with the token it belongs to
			// (drive#557) for the same reason `drive login` keeps it.
			TokenExpiresAt: signed.ExpiresAt,
			AccountID:      signed.Account.ID,
			AccountName:    signed.Account.Name,
			AccountEmail:   signed.Account.Email,
		}
		if err := SaveCredentials(env.Home, creds); err != nil {
			return env, err
		}
		who := accountLabel(signed.Account)
		if who == "" {
			fmt.Println("Signed in")
		} else {
			fmt.Printf("Signed in as %s\n", who)
		}
	}
	client, err := NewAPIClient(base, creds.DeviceToken)
	if err != nil {
		return env, err
	}
	// The same re-sign-in every other account route gets, so a `drive agents`
	// that meets a dead sign-in heals itself instead of telling the person to
	// sign in again (drive#557).
	client.Re = deviceReSigner{home: env.Home, base: base, out: os.Stdout}
	env.Minter = ToolMinter{Client: client, Home: env.Home}
	return env, nil
}

// failureKind names the message table kind of err, or "" when err did not
// come from the table. Callers use it to tell "the caller asked for no api"
// (a note, keep going) from every other sign-in failure (real, stop).
func failureKind(err error) string {
	var f *failure
	if errors.As(err, &f) {
		return f.Kind
	}
	return ""
}

// initAgents signs the device in, then finds every installed agent tool and
// connects it to the drive folder with its own key. A tool that fails is
// reported but does not stop the rest; a non-zero exit is returned if any
// tool failed. The environment is injected so the command is tested without
// touching a real machine or the network.
//
// The first run prints only what a person needs (drive#117): sign in, one line
// per agent tool, and one closing line - where the drive is and what to try, or
// the exact command that mounts it next.
func initAgents(env Env, apiBase ...string) error {
	base := ""
	if len(apiBase) > 0 {
		base = apiBase[0]
	}
	signedIn, err := signedInEnv(env, base)
	if err != nil {
		// A device with no api Worker can still register the stock MCP server;
		// it just has no per-tool storage key to put in the entry. That is said
		// out loud rather than silently skipped. Any other sign-in failure is
		// real and stops the run.
		if failureKind(err) != "no-api" {
			return err
		}
		fmt.Println("note: no drive api configured, so tools connect without their own keys (run `drive login` for keys)")
	}
	env = signedIn
	// Nothing on the first run may sit silent for more than two seconds: say
	// what is happening, then print the result per tool.
	all := tools()
	// Nothing on the first run may sit silent for more than two seconds: name
	// what is happening before the slow part (a key mint, a tool's own add),
	// then print the result per tool.
	installing := 0
	for _, t := range all {
		if on, _ := t.Installed(env); on {
			installing++
		}
	}
	if installing > 0 {
		fmt.Printf("Connecting %d agent tool(s)\n", installing)
	}
	connected, failed := 0, 0
	for _, t := range all {
		if on, _ := t.Installed(env); !on {
			continue
		}
		// Each tool gets its own key from the api Worker (build step 4,
		// drive#55). A mint that fails stops this tool and is reported; the
		// other tools go on, and the failed tool keeps the entry it had.
		if t.KeyEnv != "" && env.Minter != nil {
			if err := mintToolKey(env, t); err != nil {
				printToolFailure(t.Name, err)
				failed++
				continue
			}
		}
		// The tool's own path, mounted before Connect: the MCP server the
		// command registers points at it, so it has to exist first.
		dir, err := startToolAgentPath(env, t)
		if err != nil {
			printToolFailure(t.Name, err)
			failed++
			continue
		}
		// A copy per tool, so one tool's path never carries over to the next
		// tool in the loop, one that has no key and keeps the drive folder.
		toolEnv := env
		if dir != "" {
			toolEnv.AgentDir = dir
		}
		if err := t.Connect(toolEnv); err != nil {
			printToolFailure(t.Name, err)
			failed++
			continue
		}
		key, err := agentKeyFor(env.Home, t.Name)
		if err != nil {
			return err
		}
		if key == nil {
			fmt.Printf("  %-8s connected (no agent key; run `drive login` for one)\n", t.Name)
		} else {
			// The key id is not on screen: `drive agents revoke <tool>` names
			// the tool, so the id is debug detail. The capabilities are the
			// point - an agent key can never delete. The hour is the other
			// half of that key's promise (issue #106): it is an instant the
			// api Worker renews while the tool uses it.
			fmt.Printf("  %-8s connected (key: %s, %s)\n",
				t.Name, strings.Join(key.Capabilities, ", "), expiryLabel(key.ExpiresAt))
		}
		connected++
	}
	if connected == 0 && failed == 0 {
		fmt.Println("no agent tools found; install one and run `drive init` again")
	}
	if failed > 0 {
		return failf("tool-failed", fmt.Sprint(failed))
	}
	printFirstRunNext(os.Stdout, CurrentGOOS(), env.Home, env.DriveDir)
	return nil
}

// startToolAgentPath mounts the tool's agent path and returns the directory
// Connect should point the tool at. An empty directory means keep DriveDir
// (Windows, or a tool with no key). Tests replace this so they can prove the
// connect wiring without a FUSE mount.
var startToolAgentPath = startToolAgentPathLive

func startToolAgentPathLive(env Env, t Tool) (string, error) {
	return agentPathForGOOS(CurrentGOOS(), env, t)
}

// agentPathForGOOS starts the tool's agent path: its own rclone mount, holding
// the tool's own key (agentmount.go, drive#514). It is called once the tool's
// key is on disk and just before Connect, because Connect points the tool's
// MCP server and its allowed folder at the path.
//
// A path that does not come up is a named failure printed for that tool alone,
// never a fall back to the person's drive folder: the whole point of the path
// is that the mount holds the key storage already bounds. Windows has no
// proven agent mount, so the tool keeps working in the person's drive folder
// and the named failure is printed as a note.
func agentPathForGOOS(goos string, env Env, t Tool) (string, error) {
	if goos == "windows" {
		fmt.Println("note:", failf("agent-path-windows", t.Name).Error())
		return "", nil
	}
	key, err := agentKeyFor(env.Home, t.Name)
	if err != nil {
		return "", err
	}
	if key == nil {
		return "", nil
	}
	device, err := LoadStorageConfig("", "", "", "", "", "", storageFromDisk(env.Home))
	if err != nil {
		return "", failDetail("missing-config", err)
	}
	if strings.TrimSpace(device.Endpoint) == "" || strings.TrimSpace(device.Bucket) == "" {
		return "", failf("missing-config", "endpoint and bucket")
	}
	rclone, err := ResolveRclone("")
	if err != nil {
		return "", err
	}
	if err := mountAgentPaths(goos, env.Home, rclone, t.Name, device, *key, false); err != nil {
		return "", err
	}
	return AgentMountDir(env.Home, t.Name), nil
}

// printToolFailure prints one agent-tool failure the same way main prints
// every other failure: what happened and the exact next step, never a raw
// rclone or storage error (drive#117).
func printToolFailure(name string, err error) {
	var f *failure
	if !errors.As(err, &f) {
		f = failDetail("unexpected", err)
	}
	fmt.Printf("  %-8s failed: %s\n", name, f.Error())
}

// printFirstRunNext ends the first run on one clear line (drive#117): where
// the drive is and what to try when it is already mounted, and the exact
// command that mounts it when it is not. It is last, and it is one line.
func printFirstRunNext(w io.Writer, goos, home, driveDir string) {
	if on, err := Mounted(goos, home); err == nil && on {
		fmt.Fprintf(w, "Your drive is at %s. Try: echo hello > %q\n", driveDir, filepath.Join(driveDir, "hello.txt"))
		return
	}
	fmt.Fprintf(w, "Next: mount the drive - `drive mount` (give it --endpoint, --bucket and --prefix; see `drive mount --help`)\n")
}

// mintToolKey gives this tool its own key, unless it already has one: a
// second `drive init` must not leave a tool holding a key nobody knows
// about, so the existing key is reused and only the missing one is
// minted.
//
// A stored key whose hour is nearly run out is renewed instead of reused
// (issue #106). The api Worker renews a key on every request that proves the
// tool is still using it, so a connected tool never notices; a tool that sat
// idle for longer than its hour outlives its credential, and its next request
// is refused. Renewing here is what brings it back without a person minting a
// second key, and it changes nothing else on disk: the credential is not
// replaced, so the tool's own MCP entry keeps working. What is written is the
// renewed expiry, so the next command reads the Worker's own answer rather
// than the mint's, and does not renew a key that already has an hour left.
func mintToolKey(env Env, t Tool) error {
	if env.Minter == nil {
		return nil
	}
	existing, err := agentKeyFor(env.Home, t.Name)
	if err != nil {
		return err
	}
	if existing == nil {
		if _, err := env.Minter.MintKey("agent", t.Name); err != nil {
			return failDetail(apiFailureKind(err), err)
		}
		return nil
	}
	if !needsRenew(existing, time.Now()) {
		return nil
	}
	renewed, err := env.Minter.RenewKey(existing.KeyID)
	if err != nil {
		// A renewal that fails is reported, not swallowed: the key on disk is
		// the one the tool is using, and a tool about to be left with a key
		// whose hour has run out is a thing a person has to be told about. The
		// words are the one table's, so this reads like every other failure
		// the CLI prints.
		return failDetail("key-renew-failed", err, t.Name)
	}
	// Only the window moves, so only the expiry is written back: the pair the
	// tool holds is the one it had.
	existing.ExpiresAt = renewed.ExpiresAt
	return saveAgentKey(env.Home, t.Name, MintedKey(*existing))
}

// runAgents handles `drive agents`, `drive agents connect <tool>` and
// `drive agents revoke <tool>`.
func runAgents(args []string) error {
	api := os.Getenv("DRIVE_API_URL")
	home := os.Getenv("HOME")
	var positional []string
	for i := 0; i < len(args); i++ {
		a := args[i]
		switch {
		case a == "--home":
			if i+1 >= len(args) {
				return usageFailure(agentsUsage, "--home needs a value")
			}
			home = args[i+1]
			i++
		case strings.HasPrefix(a, "--home="):
			home = strings.TrimPrefix(a, "--home=")
		case a == "--api":
			if i+1 >= len(args) {
				return usageFailure(agentsUsage, "--api needs a value")
			}
			api = args[i+1]
			i++
		case strings.HasPrefix(a, "--api="):
			api = strings.TrimPrefix(a, "--api=")
		case a == "-h" || a == "--help":
			fmt.Print(agentsUsage)
			return nil
		case strings.HasPrefix(a, "-"):
			return usageFailure(agentsUsage, fmt.Sprintf("unknown flag %q", a))
		default:
			positional = append(positional, a)
		}
	}
	base, err := resolveAPIBase(home, api)
	if err != nil {
		return err
	}
	return agents(Env{Home: home}.withDefaults(), positional, base)
}

// usageFailure prints the command's usage and the reason to stderr, and
// returns errFlagParse so main exits 2 (usage, not failure). A bad flag or a
// bad subcommand is not a system failure: the usage block is the next step.
func usageFailure(usage, reason string) error {
	fmt.Fprintf(os.Stderr, "%s\n%s", reason, usage)
	return errFlagParse
}

// agents is runAgents' body with the environment injected.
func agents(env Env, positional []string, apiBase ...string) error {
	base := ""
	if len(apiBase) > 0 {
		base = apiBase[0]
	}
	if len(positional) == 0 {
		return listAgents(env)
	}
	sub := positional[0]
	if sub != "connect" && sub != "revoke" {
		return usageFailure(agentsUsage,
			fmt.Sprintf("unknown `drive agents` subcommand %q (use connect or revoke, or no argument to list)", sub))
	}
	if len(positional) != 2 {
		return usageFailure(agentsUsage, fmt.Sprintf("usage: drive agents %s <tool>", sub))
	}
	t, err := toolByName(positional[1])
	if err != nil {
		return err
	}
	installed, where := t.Installed(env)
	if !installed {
		return failDetail("tool-not-installed", fmt.Errorf("%s not found on PATH and no config directory",
			strings.Join(t.Binaries, " or ")), t.Name)
	}
	env, err = signedInEnv(env, base)
	if err != nil {
		// Same rule as `drive init`: a device with no api Worker can still
		// disconnect a tool locally, but it has no server-side key to revoke.
		// Any other failure is real and stops the run.
		if failureKind(err) != "no-api" {
			return err
		}
		fmt.Println("note: no drive api configured, so there is no server-side key to revoke (run the command with `--api <url>` for one)")
	}
	if sub == "connect" {
		if t.KeyEnv != "" && env.Minter != nil {
			if err := mintToolKey(env, t); err != nil {
				return err
			}
		}
		dir, err := startToolAgentPath(env, t)
		if err != nil {
			return err
		}
		if dir != "" {
			env.AgentDir = dir
		}
		if err := t.Connect(env); err != nil {
			return err
		}
		wherePath := env.AgentDir
		if wherePath == "" {
			wherePath = env.DriveDir
		}
		fmt.Printf("%s connected to %s (%s)\n", t.Name, wherePath, where)
		return nil
	}
	// Stop the agent path first, then revoke the key: a revoked agent's path
	// must stop being readable even if the withdrawal at the provider takes a
	// moment (agentmount.go UnmountAgent).
	if err := UnmountAgent(CurrentGOOS(), env.Home, t.Name); err != nil {
		return err
	}
	// Then revoke the key server-side: the local copy is only deleted once
	// the api Worker says the key is dead, so a failed revoke leaves a key
	// that still works rather than a key nothing can revoke. A tool with no
	// stored key (never connected with a signed-in device) has nothing to
	// revoke server-side.
	key, err := agentKeyFor(env.Home, t.Name)
	if err != nil {
		return err
	}
	if key != nil {
		if env.Minter == nil {
			return failf("no-api-for-key", t.Name)
		}
		if err := env.Minter.RevokeKey(key.KeyID); err != nil {
			return failDetail(apiFailureKind(err), err, t.Name)
		}
		if err := removeAgentKey(env.Home, t.Name); err != nil {
			return err
		}
	}
	if err := t.Revoke(env); err != nil {
		return err
	}
	fmt.Printf("%s disconnected\n", t.Name)
	return nil
}

const agentsUsage = `usage:
  drive agents [--home <dir>] [--api <url>]                list tools and their drive connection
  drive agents connect <tool> [--home <dir>] [--api <url>]  connect one tool
  drive agents revoke <tool> [--home <dir>] [--api <url>]   disconnect one tool
`

// listAgents prints a table of every known tool with its installed state and
// whether the drive is currently connected.
func listAgents(env Env) error {
	fmt.Printf("%-8s %-10s %s\n", "TOOL", "INSTALLED", "DRIVE")
	for _, t := range tools() {
		installed, _ := t.Installed(env)
		if !installed {
			fmt.Printf("%-8s %-10s %s\n", t.Name, "no", "-")
			continue
		}
		state := "unknown"
		if connected, err := t.Connected(env); err != nil {
			state = "unknown (" + err.Error() + ")"
		} else if connected {
			state = "connected"
		} else {
			state = "not connected"
		}
		fmt.Printf("%-8s %-10s %s\n", t.Name, "yes", state)
	}
	return nil
}
