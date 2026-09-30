package main

import (
	"fmt"
	"os"
)

const usage = `drive - a Finder drive for people and their agents

Usage:
  drive init [flags]                    find installed agent tools and connect each to the drive
  drive agents [flags]                  list agent tools and whether the drive is connected
  drive agents connect <tool> [flags]   connect one agent tool to the drive
  drive agents revoke <tool> [flags]    disconnect one agent tool from the drive
  drive search <words> [flags]          find files by name, from the drive index
  drive version                         print the version

Flags:
  --home   home directory (default $HOME)
  --api    drive api base URL for drive search (default $DRIVE_API_URL)

Tools: claude, codex, cursor, gemini, kiro

Each tool is connected to the stock MCP filesystem server over the drive
folder, using the tool's own mcp add command or its JSON config file.
`

const version = "0.1.0"

func main() {
	if len(os.Args) < 2 {
		fmt.Fprint(os.Stderr, usage)
		os.Exit(2)
	}
	var err error
	switch os.Args[1] {
	case "init":
		err = runInit(os.Args[2:])
	case "agents":
		err = runAgents(os.Args[2:])
	case "search":
		err = runSearch(os.Args[2:])
	case "version", "--version", "-v":
		fmt.Println(version)
	case "help", "--help", "-h":
		fmt.Print(usage)
	default:
		fmt.Fprintf(os.Stderr, "unknown command %q\n\n%s", os.Args[1], usage)
		os.Exit(2)
	}
	if err != nil {
		fmt.Fprintln(os.Stderr, "drive:", err)
		os.Exit(1)
	}
}
