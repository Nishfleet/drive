// `drive update` (drive issue #237, slice 4 of the account lifecycle in
// drive#34): replace the installed drive binary with the latest released
// version, and say which version is now installed.
//
// The install today is `go install github.com/Nishfleet/drive/cmd/drive@latest`
// (docs-site/quickstart.md), so the update path is the same toolchain
// invocation: it lands the binary exactly where `go install` puts it, needs no
// download URL, no unpacking step and no checksum file of our own, and reuses
// the Go toolchain's own verification of what it fetches. A released version is
// a Git tag on this repository that the module proxy serves, so the version
// check reads the proxy's `@latest` answer — the same answer `go install
// @latest` resolves through, never a second source that could disagree with
// what is about to be installed.
//
// `drive version` reports the module version the toolchain recorded in the
// binary, which is the tag the binary was installed at. Without that, every
// binary printed the source-tree fallback and an update was invisible: the one
// thing this slice has to prove.

package main

import (
	"debug/buildinfo"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime/debug"
	"strings"
	"time"
)

// updateModule is the module this CLI is built from (go.mod: `module
// github.com/Nishfleet/drive`). updateModulePath is derived from it so the
// package path and the module path cannot drift apart.
const updateModule = "github.com/Nishfleet/drive"

// updateModulePath is the package the docs install
// (docs-site/quickstart.md). One path, named once, so the install this command
// drives cannot drift from the one a person ran by hand.
const updateModulePath = updateModule + "/cmd/drive"

// updateTimeout bounds the released-version read. An update command that
// cannot reach the proxy must say so inside a command's worth of time, not
// hold the terminal.
const updateTimeout = 30 * time.Second

// noProxySentinel is the GOPROXY entry that means "no module proxy": the
// toolchain resolves modules through VCS instead, so there is no proxy to ask
// for the latest release and this command must say so rather than read a
// version no install could produce.
const noProxySentinel = "off"

// updateOptions is everything one `drive update` run needs. Every default
// lives in updateDrive, so the zero value runs the production path: the
// module proxy at moduleProxyBase, `go` from PATH in this process's
// environment, this process's version, stdout and stderr. The fields a test
// sets are the same values production reads; none of them changes which code
// runs.
type updateOptions struct {
	// proxyBase is the module proxy the released version is read from.
	// Empty means the toolchain's own effective GOPROXY (see
	// effectiveProxyBase), so the version check and the install it gates
	// resolve through the same proxy. A test pins it at a local server.
	proxyBase string
	// goBin is the Go toolchain to drive; empty means `go` from PATH
	// (DRIVE_GO fills it, the way --rclone and DRIVE_RCLONE do).
	goBin string
	// goEnv is the environment the toolchain runs with; nil means this
	// process's environment. A test pins GOPATH, GOBIN, GOPROXY and
	// GOSUMDB to its own directories so an install touches nothing outside
	// the test.
	goEnv []string
	// dir is the working directory the toolchain runs in; empty means the
	// current directory. Running `go install <path>@latest` from inside a
	// checkout of the module itself is a working-tree build, not an
	// install at the released version, so a test points this at a plain
	// directory.
	dir string
	// from is the version this binary reports. Empty means read it from
	// this process's build information.
	from string
	// checkOnly is `--check`: report the released version, install nothing.
	checkOnly bool
	// out and err take the human lines; err also takes the toolchain's own
	// output, so a slow install is never a silent one.
	out io.Writer
	err io.Writer
}

// runUpdate is `drive update [--check] [--go <path>]`.
func runUpdate(args []string) error {
	fs := flag.NewFlagSet("update", flag.ContinueOnError)
	checkOnly := fs.Bool("check", false, "say whether a newer release exists, install nothing")
	goBin := fs.String("go", os.Getenv("DRIVE_GO"), "path to the go toolchain (env DRIVE_GO, default go from PATH)")
	if err := fs.Parse(args); err != nil {
		return errFlagParse
	}
	if fs.NArg() > 0 {
		return fmt.Errorf("unexpected argument %q", fs.Arg(0))
	}
	return updateDrive(updateOptions{
		goBin:     *goBin,
		checkOnly: *checkOnly,
		goEnv:     os.Environ(),
		out:       os.Stdout,
		err:       os.Stderr,
	})
}

// updateDrive is the one `drive update` run: read the latest released
// version, install it with the Go toolchain unless it is already installed or
// --check was passed, then report the version the installed binary carries.
func updateDrive(o updateOptions) error {
	// A caller that leaves out and err unset gets the console, not a nil
	// writer, so the zero value is the production path rather than a panic.
	out, errw := o.out, o.err
	if out == nil {
		out = os.Stdout
	}
	if errw == nil {
		errw = os.Stderr
	}
	// The version check and the install it gates resolve through one proxy.
	// `go install @latest` follows the toolchain's effective GOPROXY, so a
	// hard-coded proxy.golang.org here could read a version from a feed the
	// install never consults. The toolchain is asked, and only a test's own
	// proxyBase overrides the answer.
	//
	// The toolchain is resolved first, because asking it is the way the
	// proxy is read: a machine with no Go on PATH has no install to drive,
	// so it fails with the missing-toolchain error rather than a proxy one.
	goBin, err := resolveGo(o.goBin)
	if err != nil {
		return err
	}
	proxyBase := o.proxyBase
	if proxyBase == "" {
		proxyBase, err = effectiveProxyBase(goBin, o.goEnv)
		if err != nil {
			return err
		}
	}
	latest, err := latestModuleVersion(proxyBase)
	if err != nil {
		return err
	}
	from := o.from
	if from == "" {
		from = versionText()
	}
	if from == latest {
		fmt.Fprintf(out, "drive is up to date (%s)\n", from)
		return nil
	}
	if o.checkOnly {
		fmt.Fprintf(out, "a newer drive is available: %s (this machine runs %s)\n", latest, from)
		return nil
	}
	if err := installLatestRelease(goBin, o.goEnv, o.dir, out, errw); err != nil {
		return err
	}
	installed, err := installedDrivePath(goBin, o.goEnv)
	if err != nil {
		return err
	}
	to, err := binaryVersionAt(installed)
	if err != nil {
		return err
	}
	fmt.Fprintf(out, "updated drive %s -> %s (%s)\n", from, to, installed)
	return nil
}

// latestModuleVersion reads the module proxy's `@latest` answer, the version
// `go install <updateModulePath>@latest` resolves to. A released version is a
// tag on this module, so the question is asked of the module root — `@latest`
// is a module version, not a package one. The proxy is the release feed for a
// Go module: a version is on it once its tag is, so this is the
// released-tags check, and it cannot name a version the install cannot then
// produce.
func latestModuleVersion(proxyBase string) (string, error) {
	client := &http.Client{Timeout: updateTimeout}
	url := strings.TrimSuffix(proxyBase, "/") + "/" + moduleProxyPath(updateModule) + "/@latest"
	resp, err := client.Get(url)
	if err != nil {
		return "", fmt.Errorf("read the latest released version from %s: %w", proxyBase, err)
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode != http.StatusOK {
		return "", fmt.Errorf("read the latest released version from %s: the proxy answered %s",
			proxyBase, resp.Status)
	}
	var release struct {
		Version string `json:"Version"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&release); err != nil {
		return "", fmt.Errorf("read the latest released version from %s: %w", url, err)
	}
	if release.Version == "" {
		return "", fmt.Errorf("read the latest released version from %s: the proxy named no version", url)
	}
	return release.Version, nil
}

// moduleProxyPath escapes a module path the way the module proxy protocol
// writes it in a URL: every uppercase letter becomes `!` plus its lowercase
// (the module path is case-sensitive, and a URL path is not), so
// `github.com/Nishfleet/drive` is `github.com/!nishfleet/drive`. Measured
// against a local proxy on 2026-10-03: a request for the unescaped path
// answered 404, the escaped path answered with the module's files.
func moduleProxyPath(path string) string {
	var b strings.Builder
	for i := 0; i < len(path); i++ {
		c := path[i]
		if 'A' <= c && c <= 'Z' {
			b.WriteByte('!')
			c += 'a' - 'A'
		}
		b.WriteByte(c)
	}
	return b.String()
}

// installLatestRelease runs `go install <updateModulePath>@latest` and
// streams its output, so a download the user can see is never mistaken for a
// hang. exec.Command takes an argument vector and runs no shell; the binary is
// the toolchain this command resolved, and the arguments are fixed strings.
// dir applies to the install only, like a command someone runs with `cd`:
// production leaves it empty, and a test pins it so the install cannot read
// this checkout as the working tree.
func installLatestRelease(goBin string, env []string, dir string, out, errw io.Writer) error {
	// nosemgrep: go.lang.security.audit.dangerous-exec-command.dangerous-exec-command -- the binary is the resolved go toolchain, the arguments are the fixed module path and @latest, and exec.Command takes an argument vector, not a shell.
	cmd := exec.Command(goBin, "install", updateModulePath+"@latest")
	cmd.Dir = dir
	cmd.Env = env
	cmd.Stdout = out
	cmd.Stderr = errw
	if err := cmd.Run(); err != nil {
		return fmt.Errorf("go install %s@latest: %w", updateModulePath, err)
	}
	return nil
}

// effectiveProxyBase is the module proxy the toolchain will resolve
// `go install <updateModulePath>@latest` through: the first URL in the
// effective GOPROXY. Asking the toolchain (`go env -json GOPROXY`) is what
// makes this one source of truth with the install, instead of a second place
// a proxy URL is written down.
//
// GOPROXY is a comma-separated list ending in `,direct` on a stock install,
// and `direct` resolves through VCS with no module proxy in front of it, so
// there is no `@latest` answer to read. A machine that has turned the proxy
// off (`GOPROXY=off`) has the same problem and gets the same named error,
// rather than this command quietly reading a version nothing could install.
func effectiveProxyBase(goBin string, env []string) (string, error) {
	// nosemgrep: go.lang.security.audit.dangerous-exec-command.dangerous-exec-command -- the binary is the resolved go toolchain, the argument is the fixed GOPROXY name, and exec.Command takes an argument vector, not a shell.
	cmd := exec.Command(goBin, "env", "-json", "GOPROXY")
	cmd.Env = env
	raw, err := cmd.Output()
	if err != nil {
		return "", fmt.Errorf("ask %s which module proxy it installs from: %w", goBin, err)
	}
	var cfg struct {
		GOPROXY string
	}
	if err := json.Unmarshal(raw, &cfg); err != nil {
		return "", fmt.Errorf("ask %s which module proxy it installs from: %s", goBin, strings.TrimSpace(string(raw)))
	}
	for _, entry := range strings.Split(cfg.GOPROXY, ",") {
		entry = strings.TrimSpace(entry)
		if entry == "" || entry == noProxySentinel || entry == "direct" {
			continue
		}
		return entry, nil
	}
	return "", fmt.Errorf("this machine resolves Go modules with GOPROXY=%s, which names no module proxy, so the latest release cannot be read; set GOPROXY to a proxy URL (for example https://proxy.golang.org) and run drive update again", cfg.GOPROXY)
}

// installedDrivePath is where `go install <updateModulePath>@latest` writes
// the binary: $GOBIN, or $GOPATH/bin. GOEXE carries the platform suffix, which
// is empty on macOS and Linux, the two platforms drive ships
// (docs-site/limits.md). Reading it out of the toolchain rather than guessing
// $HOME/go means an install this command just ran is never reported at a path
// it did not write to.
//
// GOPATH is a list, and the toolchain installs into the first entry, so this
// takes the first entry too. Joining the whole value would name a directory
// (`/home/u/go:/opt/go`) that does not exist, and the command would then fail
// to read back the binary it had just installed.
func installedDrivePath(goBin string, env []string) (string, error) {
	// nosemgrep: go.lang.security.audit.dangerous-exec-command.dangerous-exec-command -- the binary is the resolved go toolchain, the arguments are the fixed env names, and exec.Command takes an argument vector, not a shell.
	cmd := exec.Command(goBin, "env", "-json", "GOBIN", "GOPATH", "GOEXE")
	cmd.Env = env
	raw, err := cmd.Output()
	if err != nil {
		return "", fmt.Errorf("ask %s where it installs binaries: %w", goBin, err)
	}
	var paths struct {
		GOBIN  string
		GOPATH string
		GOEXE  string
	}
	if err := json.Unmarshal(raw, &paths); err != nil {
		return "", fmt.Errorf("ask %s where it installs binaries: %s", goBin, strings.TrimSpace(string(raw)))
	}
	bin := paths.GOBIN
	if bin == "" {
		first, ok := firstGOPATHEntry(paths.GOPATH)
		if !ok {
			return "", fmt.Errorf("%s installs to an empty GOBIN and reports no GOPATH", goBin)
		}
		bin = filepath.Join(first, "bin")
	}
	return filepath.Join(bin, "drive"+paths.GOEXE), nil
}

// firstGOPATHEntry is the first directory in a GOPATH value, which is the one
// the toolchain installs binaries into. A GOPATH with several entries names
// the same install directory whichever way the rest is used. An empty value,
// or one that holds only separators, has no entry to install into.
func firstGOPATHEntry(gopath string) (string, bool) {
	for _, entry := range strings.Split(gopath, string(os.PathListSeparator)) {
		if entry != "" {
			return entry, true
		}
	}
	return "", false
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
// `go version -m` does. `drive update` reads the binary it just installed
// rather than assuming the install worked: the version on disk is the one this
// command is answerable for, and it is the one `drive version` will print.
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

// resolveGo resolves the Go toolchain `drive update` drives, the way
// ResolveRclone resolves the rclone binary `drive mount` drives: a --go path
// or DRIVE_GO first, then `go` from PATH.
func resolveGo(goBin string) (string, error) {
	if goBin == "" {
		goBin = os.Getenv("DRIVE_GO")
	}
	if goBin == "" {
		path, err := exec.LookPath("go")
		if err != nil {
			return "", fmt.Errorf("go not found on PATH: %w (install Go from https://go.dev, or install the new binary by hand: go install %s@latest)", err, updateModulePath)
		}
		return path, nil
	}
	path, err := exec.LookPath(goBin)
	if err != nil {
		return "", fmt.Errorf("go binary %q not found: %w", goBin, err)
	}
	return path, nil
}
