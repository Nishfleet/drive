// `drive update` (drive issue #509): hand off to the package manager that
// installed this binary. brew, apt, dnf and winget are the routes a release
// actually publishes; `go install @latest` needs a public module and a Go
// toolchain, and neither is how the packages ship.
//
// Detection asks the package manager, not the binary's path: Homebrew, dpkg,
// rpm and winget each know whether they own the `drive` package. An unknown
// install is a named error that prints the same three lines the docs lead
// with, so the next step is the one-line install, not a second updater.
//
// `drive version` still reports the module version the toolchain recorded in
// this binary, which is the tag goreleaser stamped.

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

// The install lines .goreleaser.yaml publishes. test/packaging.test.mjs
// derives the same three from that YAML and fails when these constants drift.
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

// commandRunner starts one program with an argument vector, not a shell.
type commandRunner func(name string, args []string, out, errw io.Writer) error

// captureRunner is commandRunner for detection: stdout is returned, and a
// non-zero exit is an error the detector treats as "not this route".
type captureRunner func(name string, args []string) (string, error)

// updateOptions is everything one `drive update` run needs. The zero value is
// the production path: look up binaries on PATH, run them, write the console.
type updateOptions struct {
	// from is the version this binary reports. Empty means read it from
	// this process's build information.
	from string
	// checkOnly is `--check`: report whether an update exists, install nothing.
	checkOnly bool
	// exe is this binary's path, used to read the version after an upgrade.
	// Empty means os.Executable().
	exe string
	// lookPath finds a binary on PATH; nil means exec.LookPath.
	lookPath func(string) (string, error)
	// run is the install/upgrade invocation; nil means exec.Command.
	run commandRunner
	// capture is the detection / --check invocation; nil means exec.Command
	// with CombinedOutput.
	capture captureRunner
	// out and err take the human lines; err also takes the package manager's
	// own output, so a slow upgrade is never a silent one.
	out io.Writer
	err io.Writer
	// home and rclone are where the mount lives and how it is found, read
	// after a successful install: `drive update` restarts a mount that is
	// still running the old binary (drive#560).
	home   string
	rclone string
	// restartMount is what lets the install restart a running mount. It is
	// deliberately not part of the zero-value production path: the unit
	// tests call updateDrive against a temp home and a local proxy, and
	// restarting the machine's real mount is not something a test may do.
	// runUpdate sets it; drive update is the one caller of that path.
	restartMount bool
}

// runUpdate is `drive update [--check] [--home <dir>] [--rclone <path>]`.
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

// updateDrive is the one `drive update` run: detect the install route, ask
// that package manager whether a newer package exists, and either report or
// hand off the upgrade to it. An up-to-date machine does not run sudo.
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
	home := o.home
	if home == "" {
		home = os.Getenv("HOME")
	}
	// The installed binary changed while the mount was running, and a mount
	// serves the code it started with, so the update does not take effect on
	// a running mount until it is restarted (drive#560). This runs only after
	// the package manager's own upgrade, and it restarts nothing when this
	// machine has no mount up.
	if o.restartMount {
		if on, mErr := Mounted(CurrentGOOS(), home); mErr == nil && on {
			if err := restartMountAfterUpdate(o.rclone, home); err != nil {
				return failDetail("update-restart", err)
			}
			fmt.Fprintln(out, "drive: mount restarted on the new drive")
		}
	}
	// rclone below the floor makes the mount's flags fail (drive#105). The
	// update is the one moment a person is likely to act, so this says so;
	// an old rclone never fails an update that already succeeded.
	if rcloneBin, rErr := ResolveRclone(o.rclone); rErr == nil {
		if err := CheckRclone(CurrentGOOS(), rcloneBin); err != nil {
			fmt.Fprintln(out, err)
		}
	} else {
		fmt.Fprintln(out, RcloneInstallHint(CurrentGOOS(), true))
	}
	return nil
}

// restartMountAfterUpdate restarts this machine's drive mount after the
// binary changed under it, because a mount keeps running the code it started
// with. It is the same restart `drive cap` runs: rclone from the flag or
// PATH, the secret from the environment or this CLI's own 0600 config in
// that order and never a fourth, then the one RestartMount call that unmounts
// without touching the VFS cache its queued uploads live in. It is written
// out here rather than shared with cap.go's swap restart, because cap's
// restart is money-touching (the spending cap) and this change does not
// modify that path.
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

// detectInstallRoute asks brew, dpkg, rpm and winget, in that order, whether
// they own the drive package. The first yes wins. None of them is an unknown
// install: the error names the three lines a person pastes to put drive on a
// supported route. brew is asked for the tap cask first so a core cask named
// `drive` cannot steal the route. apt/dnf must be on PATH because they are
// the commands the upgrade actually runs.
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

// packageHasUpdate asks the same package manager the upgrade would drive.
// Empty or "up to date" output means no update; any named newer package is yes.
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

// versionText is what `drive version` prints: the module version the toolchain
// recorded in this binary, which is the tag it was installed at. A binary
// built from a checkout (`go build`, `go run`, `go test`) records no module
// version, so it falls back to the source-tree version.
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

// moduleVersion is a build information's module version when it names a
// released version. Every other value is the toolchain saying "built from a
// working tree": an empty version, or the literal `(devel)`.
func moduleVersion(info *debug.BuildInfo) string {
	v := info.Main.Version
	if v == "" || v == "(devel)" {
		return ""
	}
	return v
}

// binaryVersionAt reads the version the drive binary at path reports, the way
// `go version -m` does. Tests use it to prove a checkout build falls back to
// the source-tree version.
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
