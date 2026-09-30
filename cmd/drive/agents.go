package main

import (
	"flag"
	"fmt"
	"os"
	"strings"
)

// runInit is the `drive init` command.
func runInit(args []string) error {
	fs := flag.NewFlagSet("init", flag.ContinueOnError)
	home := fs.String("home", os.Getenv("HOME"), "home directory")
	if err := fs.Parse(args); err != nil {
		return err
	}
	return initAgents(Env{Home: *home}.withDefaults())
}

// initAgents finds every installed agent tool and connects it to the drive
// folder. A tool that fails is reported but does not stop the rest; a
// non-zero exit is returned if any tool failed. The environment is injected
// so the command is tested without touching a real machine.
func initAgents(env Env) error {
	fmt.Printf("drive folder: %s\n", env.DriveDir)
	connected, failed := 0, 0
	for _, t := range tools() {
		installed, _ := t.Installed(env)
		if !installed {
			fmt.Printf("  %-8s not installed\n", t.Name)
			continue
		}
		if err := t.Connect(env); err != nil {
			fmt.Printf("  %-8s failed: %v\n", t.Name, err)
			failed++
			continue
		}
		fmt.Printf("  %-8s connected\n", t.Name)
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

// runAgents handles `drive agents`, `drive agents connect <tool>` and
// `drive agents revoke <tool>`.
func runAgents(args []string) error {
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
		case a == "-h" || a == "--help":
			fmt.Print(agentsUsage)
			return nil
		case strings.HasPrefix(a, "-"):
			return fmt.Errorf("unknown flag %q", a)
		default:
			positional = append(positional, a)
		}
	}
	return agents(Env{Home: home}.withDefaults(), positional)
}

// agents is runAgents' body with the environment injected.
func agents(env Env, positional []string) error {
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
	if sub == "connect" {
		if err := t.Connect(env); err != nil {
			return err
		}
		fmt.Printf("%s connected to %s (%s)\n", t.Name, env.DriveDir, where)
		return nil
	}
	if err := t.Revoke(env); err != nil {
		return err
	}
	fmt.Printf("%s disconnected\n", t.Name)
	return nil
}

const agentsUsage = `usage:
  drive agents [--home <dir>]                  list tools and their drive connection
  drive agents connect <tool> [--home <dir>]   connect one tool
  drive agents revoke <tool> [--home <dir>]    disconnect one tool
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
