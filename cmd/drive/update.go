package main

import (
	"debug/buildinfo"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"os/exec"
	"runtime/debug"
	"strings"
)

const (
	brewInstallLine = "brew install nish3451/tap/drive"
	aptInstallLine  = "sudo apt install ./drive_*.deb"
	dnfInstallLine  = "sudo dnf install ./drive_*.rpm"
	brewCask        = "nish3451/tap/drive"
	wingetPackageID = "Nishfleet.Drive"
)

type installKind int

const (
	routeUnknown installKind = iota
	routeBrew
	routeApt
	routeDnf
	routeWinget
)

func (k installKind) String() string {
	switch k {
	case routeBrew:
		return "brew"
	case routeApt:
		return "apt"
	case routeDnf:
		return "dnf"
	case routeWinget:
		return "winget"
	default:
		return "unknown"
	}
}

type commandRunner func(name string, args []string, out, errw io.Writer) error

type captureRunner func(name string, args []string) (string, error)

type updateOptions struct {
	from         string
	checkOnly    bool
	exe          string
	lookPath     func(string) (string, error)
	run          commandRunner
	capture      captureRunner
	out          io.Writer
	err          io.Writer
	home         string
	rclone       string
	restartMount bool
}

func runUpdate(args []string) error {
	fs := flag.NewFlagSet("update", flag.ContinueOnError)
	common := addCommonFlags(fs)
	checkOnly := fs.Bool("check", false, "say whether a newer release exists, install nothing")
	if err := fs.Parse(args); err != nil {
		return errFlagParse
	}
	if fs.NArg() > 0 {
		return fmt.Errorf("unexpected argument %q", fs.Arg(0))
	}
	return updateDrive(updateOptions{
		checkOnly:    *checkOnly,
		out:          os.Stdout,
		err:          os.Stderr,
		home:         common.home,
		rclone:       common.rclone,
		restartMount: true,
	})
}

func defaultLookPath(name string) (string, error) {
	return exec.LookPath(name)
}

func defaultRun(name string, args []string, out, errw io.Writer) error {
	// nosemgrep: go.lang.security.audit.dangerous-exec-command.dangerous-exec-command -- the binary is a resolved package manager, the arguments are fixed strings, and exec.Command takes an argument vector, not a shell.
	cmd := exec.Command(name, args...)
	cmd.Stdin = os.Stdin
	cmd.Stdout = out
	cmd.Stderr = errw
	return cmd.Run()
}

func defaultCapture(name string, args []string) (string, error) {
	// nosemgrep: go.lang.security.audit.dangerous-exec-command.dangerous-exec-command -- the binary is a resolved package manager, the arguments are fixed strings, and exec.Command takes an argument vector, not a shell.
	cmd := exec.Command(name, args...)
	raw, err := cmd.CombinedOutput()
	return string(raw), err
}

func lookPathOr(fn func(string) (string, error)) func(string) (string, error) {
	if fn == nil {
		return defaultLookPath
	}
	return fn
}

func runOr(fn commandRunner) commandRunner {
	if fn == nil {
		return defaultRun
	}
	return fn
}

func captureOr(fn captureRunner) captureRunner {
	if fn == nil {
		return defaultCapture
	}
	return fn
}

func updateDrive(o updateOptions) error {
	out, errw := o.out, o.err
	if out == nil {
		out = os.Stdout
	}
	if errw == nil {
		errw = os.Stderr
	}
	lookPath := lookPathOr(o.lookPath)
	run := runOr(o.run)
	capture := captureOr(o.capture)

	kind, err := detectInstallRoute(lookPath, capture)
	if err != nil {
		return err
	}
	from := o.from
	if from == "" {
		from = versionText()
	}

	newer, err := packageHasUpdate(kind, capture)
	if err != nil {
		return err
	}
	if !newer {
		fmt.Fprintf(out, "drive is up to date (%s)\n", from)
		if !o.checkOnly && (kind == routeApt || kind == routeDnf) {
			fmt.Fprintf(out, "if a newer package is on the GitHub release, download it and run:\n  %s\n", installLine(kind))
		}
		return nil
	}
	if o.checkOnly {
		fmt.Fprintf(out, "a newer drive is available via %s (this machine runs %s)\n", kind, from)
		return nil
	}

	name, args := upgradeCommand(kind)
	fmt.Fprintf(out, "updating drive with %s %s\n", name, strings.Join(args, " "))
	if err := run(name, args, out, errw); err != nil {
		return fmt.Errorf("%s: %w", kind, err)
	}
	to := installedVersion(o.exe, from)
	fmt.Fprintf(out, "updated drive %s -> %s via %s\n", from, to, kind)
	rcloneReady := false
	if rcloneBin, rErr := ResolveRclone(o.rclone); rErr == nil {
		if err := CheckRclone(CurrentGOOS(), rcloneBin); err != nil {
			fmt.Fprintln(out, err)
		} else {
			rcloneReady = true
		}
	} else {
		fmt.Fprintln(out, RcloneInstallHint(CurrentGOOS(), true))
	}
	home := o.home
	if home == "" {
		home = DefaultHome()
	}
	if o.restartMount && rcloneReady {
		on, mErr := mountOn(CurrentGOOS(), home)
		switch {
		case on && mErr == nil:
			if err := restartMountAfterUpdate(o.rclone, home); err != nil {
				return failDetail("update-restart", err)
			}
			fmt.Fprintln(out, "drive: mount restarted on the new drive")
		case mErr != nil:
			fmt.Fprintf(errw, "drive update: could not tell whether %s is mounted: %v\n", DefaultMountDir(home), mErr)
		}
	}
	return nil
}

func restartMountAfterUpdate(rcloneFlag, home string) error {
	rcloneBin, err := ResolveRclone(rcloneFlag)
	if err != nil {
		return err
	}
	secretKey, err := ReadSecretKey(RcloneConfigPath(home), false, os.Stdin)
	if err != nil {
		return fmt.Errorf("restart the mount: %w", err)
	}
	cfg, err := LoadStorageConfig("", "", "", "", "", secretKey, storageFromDisk(home))
	if err != nil {
		return fmt.Errorf("restart the mount: %w", err)
	}
	if err := RestartMount(CurrentGOOS(), home, rcloneBin, cfg); err != nil {
		return fmt.Errorf("restart the mount: %w", err)
	}
	return nil
}

func installLine(kind installKind) string {
	switch kind {
	case routeBrew:
		return brewInstallLine
	case routeApt:
		return aptInstallLine
	case routeDnf:
		return dnfInstallLine
	default:
		return ""
	}
}

func installedVersion(exe, fallback string) string {
	if exe == "" {
		var err error
		exe, err = os.Executable()
		if err != nil {
			return fallback
		}
	}
	v, err := binaryVersionAt(exe)
	if err != nil {
		return fallback
	}
	return v
}

func detectInstallRoute(lookPath func(string) (string, error), capture captureRunner) (installKind, error) {
	if _, err := lookPath("brew"); err == nil {
		if _, err := capture("brew", []string{"list", "--cask", brewCask}); err == nil {
			return routeBrew, nil
		}
		if _, err := capture("brew", []string{"list", "--cask", "drive"}); err == nil {
			return routeBrew, nil
		}
	}
	if _, err := lookPath("dpkg-query"); err == nil {
		if _, err := lookPath("apt"); err == nil {
			out, err := capture("dpkg-query", []string{"-W", "-f", "${Status}", "drive"})
			if err == nil && strings.Contains(out, "installed") {
				return routeApt, nil
			}
		}
	}
	if _, err := lookPath("rpm"); err == nil {
		if _, err := lookPath("dnf"); err == nil {
			if _, err := capture("rpm", []string{"-q", "drive"}); err == nil {
				return routeDnf, nil
			}
		}
	}
	if _, err := lookPath("winget"); err == nil {
		out, err := capture("winget", []string{"list", "--id", wingetPackageID, "--disable-interactivity"})
		if err == nil && strings.Contains(out, wingetPackageID) {
			return routeWinget, nil
		}
	}
	return routeUnknown, fmt.Errorf("drive was not installed with brew, apt, dnf or winget; install it with one of:\n  %s\n  %s\n  %s\n  winget install %s", brewInstallLine, aptInstallLine, dnfInstallLine, wingetPackageID)
}

func upgradeCommand(kind installKind) (string, []string) {
	switch kind {
	case routeBrew:
		return "brew", []string{"upgrade", "--cask", brewCask}
	case routeApt:
		return "sudo", []string{"apt", "install", "--only-upgrade", "drive"}
	case routeDnf:
		return "sudo", []string{"dnf", "upgrade", "drive"}
	case routeWinget:
		return "winget", []string{"upgrade", "--id", wingetPackageID, "--disable-interactivity"}
	default:
		return "", nil
	}
}

func packageHasUpdate(kind installKind, capture captureRunner) (bool, error) {
	switch kind {
	case routeBrew:
		out, err := capture("brew", []string{"outdated", "--cask", brewCask})
		if err != nil {
			return false, fmt.Errorf("brew outdated: %w", err)
		}
		return strings.Contains(out, "drive"), nil
	case routeApt:
		out, err := capture("apt", []string{"list", "--upgradable", "drive"})
		if err != nil {
			return false, fmt.Errorf("apt list: %w", err)
		}
		for _, line := range strings.Split(out, "\n") {
			if strings.HasPrefix(line, "drive/") && strings.Contains(line, "upgradable") {
				return true, nil
			}
		}
		return false, nil
	case routeDnf:
		_, err := capture("dnf", []string{"check-update", "drive"})
		if err == nil {
			return false, nil
		}
		if exit, ok := exitCode(err); ok && exit == 100 {
			return true, nil
		}
		return false, fmt.Errorf("dnf check-update: %w", err)
	case routeWinget:
		out, err := capture("winget", []string{"list", "--id", wingetPackageID, "--disable-interactivity", "--upgrade-available"})
		if err != nil {
			return false, fmt.Errorf("winget list: %w", err)
		}
		return strings.Contains(out, wingetPackageID), nil
	default:
		return false, fmt.Errorf("no package manager to ask")
	}
}

func exitCode(err error) (int, bool) {
	var x interface{ ExitCode() int }
	if !errors.As(err, &x) {
		return 0, false
	}
	return x.ExitCode(), true
}

func versionText() string {
	info, ok := debug.ReadBuildInfo()
	if !ok {
		return version
	}
	if v := moduleVersion(info); v != "" {
		return v
	}
	return version
}

func moduleVersion(info *debug.BuildInfo) string {
	v := info.Main.Version
	if v == "" || v == "(devel)" {
		return ""
	}
	return v
}

func binaryVersionAt(path string) (string, error) {
	info, err := buildinfo.ReadFile(path)
	if err != nil {
		return "", fmt.Errorf("read the build information of %s: %w", path, err)
	}
	if v := moduleVersion(info); v != "" {
		return v, nil
	}
	return version, nil
}
