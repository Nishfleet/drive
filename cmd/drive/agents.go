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

// ToolMinter mints a tool's own agent key through the api Worker (build step 4, drive#55) and keeps it where `drive agents revoke` can find it again.
type ToolMinter struct {
	Client *APIClient
	Home   string
}

// MintKey asks the api Worker for a key of this kind and name, then stores it 0600 next to the device's rclone config.
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

// RevokeKey is the client half, called before the local copy is deleted: a key that is refused here is a key that still works server-side.
func (m ToolMinter) RevokeKey(keyID string) error {
	return m.Client.RevokeKey(keyID)
}

// RenewKey restarts the hour on a key this device already holds, and answers with the restarted row.
func (m ToolMinter) RenewKey(keyID string) (RenewedKey, error) {
	return m.Client.RenewKey(keyID)
}

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

func signedInEnv(env Env, apiBase string) (Env, error) {
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
		signed, err := SignIn(client, envDeviceName(env.Home), os.Stdout)
		if err != nil {
			return env, err
		}
		creds = Credentials{
			APIBase:        client.Base,
			DeviceToken:    signed.Token,
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
	client.Re = deviceReSigner{home: env.Home, base: base, out: os.Stdout}
	env.Minter = ToolMinter{Client: client, Home: env.Home}
	return env, nil
}

func failureKind(err error) string {
	var f *failure
	if errors.As(err, &f) {
		return f.Kind
	}
	return ""
}

func initAgents(env Env, apiBase ...string) error {
	base := ""
	if len(apiBase) > 0 {
		base = apiBase[0]
	}
	signedIn, err := signedInEnv(env, base)
	if err != nil {
		if failureKind(err) != "no-api" {
			return err
		}
		fmt.Println("note: no drive api configured, so tools connect without their own keys (run `drive login` for keys)")
	}
	env = signedIn
	all := tools()
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
		if t.KeyEnv != "" && env.Minter != nil {
			if err := mintToolKey(env, t); err != nil {
				printToolFailure(t.Name, err)
				failed++
				continue
			}
		}
		dir, err := startToolAgentPath(env, t)
		if err != nil {
			printToolFailure(t.Name, err)
			failed++
			continue
		}
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

var startToolAgentPath = startToolAgentPathLive

func startToolAgentPathLive(env Env, t Tool) (string, error) {
	return agentPathForGOOS(CurrentGOOS(), env, t)
}

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

func printToolFailure(name string, err error) {
	var f *failure
	if !errors.As(err, &f) {
		f = failDetail("unexpected", err)
	}
	fmt.Printf("  %-8s failed: %s\n", name, f.Error())
}

func printFirstRunNext(w io.Writer, goos, home, driveDir string) {
	if on, err := Mounted(goos, home); err == nil && on {
		fmt.Fprintf(w, "Your drive is at %s. Try: echo hello > %q\n", driveDir, filepath.Join(driveDir, "hello.txt"))
		return
	}
	fmt.Fprintf(w, "Next: mount the drive - `drive mount` (give it --endpoint, --bucket and --prefix; see `drive mount --help`)\n")
}

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
		return failDetail("key-renew-failed", err, t.Name)
	}
	existing.ExpiresAt = renewed.ExpiresAt
	return saveAgentKey(env.Home, t.Name, MintedKey(*existing))
}

func runAgents(args []string) error {
	api := os.Getenv("DRIVE_API_URL")
	home := DefaultHome()
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

func usageFailure(usage, reason string) error {
	fmt.Fprintf(os.Stderr, "%s\n%s", reason, usage)
	return errFlagParse
}

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
	if err := UnmountAgent(CurrentGOOS(), env.Home, t.Name); err != nil {
		return err
	}
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
