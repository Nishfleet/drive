package main

import (
	"errors"
	"flag"
	"fmt"
	"os"
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

// runInit is the `drive init` command.
func runInit(args []string) error {
	fs := flag.NewFlagSet("init", flag.ContinueOnError)
	api := fs.String("api", os.Getenv("DRIVE_API_URL"), "api Worker base URL")
	home := fs.String("home", os.Getenv("HOME"), "home directory")
	if err := fs.Parse(args); err != nil {
		return errFlagParse
	}
	if fs.NArg() > 0 {
		return fmt.Errorf("unexpected argument %q", fs.Arg(0))
	}
	return initAgents(Env{Home: *home}.withDefaults(), *api)
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
	if strings.TrimSpace(apiBase) == "" {
		return env, errors.New("no api Worker configured; set --api or DRIVE_API_URL")
	}
	creds, err := LoadCredentials(env.Home)
	if err != nil {
		return env, err
	}
	if creds.DeviceToken == "" {
		client, err := NewAPIClient(apiBase, "")
		if err != nil {
			return env, err
		}
		name, err := os.Hostname()
		if err != nil || strings.TrimSpace(name) == "" {
			name = "this device"
		}
		token, account, err := SignIn(client, name, os.Stdout)
		if err != nil {
			return env, err
		}
		creds = Credentials{APIBase: client.Base, DeviceToken: token, AccountID: account.ID, AccountName: account.Name}
		if err := SaveCredentials(env.Home, creds); err != nil {
			return env, err
		}
		fmt.Printf("signed in to %s as %s\n", client.Base, creds.AccountName)
	}
	client, err := NewAPIClient(creds.APIBase, creds.DeviceToken)
	if err != nil {
		return env, err
	}
	env.Minter = ToolMinter{Client: client, Home: env.Home}
	return env, nil
}

// initAgents signs the device in, then finds every installed agent tool and
// connects it to the drive folder with its own key. A tool that fails is
// reported but does not stop the rest; a non-zero exit is returned if any
// tool failed. The environment is injected so the command is tested without
// touching a real machine or the network.
func initAgents(env Env, apiBase ...string) error {
	fmt.Printf("drive folder: %s\n", env.DriveDir)
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
		if !strings.Contains(err.Error(), "no api Worker configured") {
			return err
		}
		fmt.Println("note: no api Worker configured; connecting without per-tool keys (set --api or DRIVE_API_URL)")
	}
	env = signedIn
	connected, failed := 0, 0
	for _, t := range tools() {
		installed, _ := t.Installed(env)
		if !installed {
			fmt.Printf("  %-8s not installed\n", t.Name)
			continue
		}
		// Each tool gets its own key from the api Worker (build step 4,
		// drive#55). A mint that fails stops this tool and is reported; the
		// other tools go on, and the failed tool keeps the entry it had.
		if t.KeyEnv != "" && env.Minter != nil {
			if err := mintToolKey(env, t); err != nil {
				fmt.Printf("  %-8s failed: %v\n", t.Name, err)
				failed++
				continue
			}
		}
		if err := t.Connect(env); err != nil {
			fmt.Printf("  %-8s failed: %v\n", t.Name, err)
			failed++
			continue
		}
		key, err := agentKeyFor(env.Home, t.Name)
		if err != nil {
			return err
		}
		if key == nil {
			fmt.Printf("  %-8s connected (no agent key; sign in with `drive init` for one)\n", t.Name)
		} else {
			fmt.Printf("  %-8s connected (agent key %s: %s, no deleteFiles, %s)\n",
				t.Name, key.KeyID, strings.Join(key.Capabilities, ", "), expiryLabel(key.ExpiresAt))
		}
		connected++
	}
	if connected == 0 && failed == 0 {
		fmt.Println("no agent tools found; install one and run `drive init` again")
	}
	if failed > 0 {
		return fmt.Errorf("%d agent tool(s) could not be connected", failed)
	}
	return nil
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
			return fmt.Errorf("mint its key: %w", err)
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
		// whose hour has run out is a thing a person has to be told about.
		return fmt.Errorf("renew the %s key: %w", t.Name, err)
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
				return fmt.Errorf("--home needs a value")
			}
			home = args[i+1]
			i++
		case strings.HasPrefix(a, "--home="):
			home = strings.TrimPrefix(a, "--home=")
		case a == "--api":
			if i+1 >= len(args) {
				return fmt.Errorf("--api needs a value")
			}
			api = args[i+1]
			i++
		case strings.HasPrefix(a, "--api="):
			api = strings.TrimPrefix(a, "--api=")
		case a == "-h" || a == "--help":
			fmt.Print(agentsUsage)
			return nil
		case strings.HasPrefix(a, "-"):
			return fmt.Errorf("unknown flag %q", a)
		default:
			positional = append(positional, a)
		}
	}
	return agents(Env{Home: home}.withDefaults(), positional, api)
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
		return fmt.Errorf("unknown `drive agents` subcommand %q (use connect or revoke, or no argument to list)", sub)
	}
	if len(positional) != 2 {
		return fmt.Errorf("usage: drive agents %s <tool>", sub)
	}
	t, err := toolByName(positional[1])
	if err != nil {
		return err
	}
	installed, where := t.Installed(env)
	if !installed {
		return fmt.Errorf("%s is not installed (%s not found on PATH and no config directory); install it first",
			t.Name, strings.Join(t.Binaries, " or "))
	}
	env, err = signedInEnv(env, base)
	if err != nil {
		// Same rule as `drive init`: a device with no api Worker can still
		// disconnect a tool locally, but it has no server-side key to revoke.
		// Any other failure is real and stops the run.
		if !strings.Contains(err.Error(), "no api Worker configured") {
			return err
		}
		fmt.Println("note: no api Worker configured; no server-side key to revoke (set --api or DRIVE_API_URL)")
	}
	if sub == "connect" {
		if t.KeyEnv != "" && env.Minter != nil {
			if err := mintToolKey(env, t); err != nil {
				return err
			}
		}
		if err := t.Connect(env); err != nil {
			return err
		}
		fmt.Printf("%s connected to %s (%s)\n", t.Name, env.DriveDir, where)
		return nil
	}
	// Revoke the key server-side first: the local copy is only deleted once
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
			return fmt.Errorf("%s has an agent key but this device cannot reach the api Worker; "+
				"set --api or DRIVE_API_URL and run this again", t.Name)
		}
		if err := env.Minter.RevokeKey(key.KeyID); err != nil {
			return fmt.Errorf("revoke the %s key: %w", t.Name, err)
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
