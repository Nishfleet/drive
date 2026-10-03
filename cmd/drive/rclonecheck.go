package main

import (
	"fmt"
	"os/exec"
	"strconv"
	"strings"
)

// MinRcloneVersion is the oldest rclone a drive mount is proven on. It is
// measured, not read off a changelog: the mount passes
// --vfs-read-chunk-streams (mount.go VFSArgs), and no rclone below 1.68.0
// accepts that flag, so an older rclone dies with `unknown flag` before the
// mount starts. Measured 2026-10-03 in a container against the builds those
// versions ship: `rclone mount --help` lists --vfs-read-chunk-streams in
// v1.68.0 and does not in v1.67.0, v1.66.0 or Ubuntu 24.04's v1.60.1, and
// `rclone mount ... --vfs-read-chunk-streams 2` on v1.60.1 prints
// "Error: unknown flag: --vfs-read-chunk-streams".
//
// The apt package on Ubuntu 24.04 LTS is therefore below this floor even
// though the .deb's Depends: rclone installs it, and RcloneInstallHint says
// so with the one command that fixes it. Raise the floor only with the same
// kind of measurement: a flag the old rclone refuses, or a mount proof that
// fails on the version below.
const MinRcloneVersion = "1.68.0"

// CheckRclone runs `<rclone> version` and fails loudly when the binary is
// missing or older than MinRcloneVersion. It runs before anything is written,
// so a first `drive init` on a fresh machine says exactly what to install
// instead of failing later inside rclone, where the reason is buried in a log.
//
// The rclone path is the one ResolveRclone already resolved (a flag value, an
// environment variable, or a PATH lookup), so nothing reachable by remote
// input is executed here: exec.Command takes an argument vector and runs no
// shell.
func CheckRclone(goos, rcloneBin string) error {
	version, err := InstalledRcloneVersion(rcloneBin)
	if err != nil {
		// A binary that will not run is the same first-run problem as a
		// missing one, and the fix is the same sentence, so both paths carry
		// the hint rather than leaving the reader to guess.
		return fmt.Errorf("%w\n%s", err, RcloneInstallHint(goos, true))
	}
	if compareVersions(version, MinRcloneVersion) >= 0 {
		return nil
	}
	return fmt.Errorf("rclone %s is too old: drive mounts need rclone %s or newer\n%s",
		version, MinRcloneVersion, RcloneInstallHint(goos, false))
}

// InstalledRcloneVersion runs the rclone binary and reads the version from its
// first line of output: `rclone v1.75.1` on the first line, then os/version and
// os/kernel. A binary that prints nothing parsable is reported with what it
// did print, because a too-old build and a broken build need different fixes.
func InstalledRcloneVersion(rcloneBin string) (string, error) {
	// rcloneBin is the path ResolveRclone already resolved (a flag, DRIVE_RCLONE,
	// or PATH). exec.Command takes an argument vector and runs no shell.
	// nosemgrep: go.lang.security.audit.dangerous-exec-command.dangerous-exec-command
	out, err := exec.Command(rcloneBin, "version").CombinedOutput()
	if err != nil {
		return "", fmt.Errorf("rclone version: %w: %s", err, firstLine(string(out)))
	}
	version, ok := parseRcloneVersion(string(out))
	if !ok {
		return "", fmt.Errorf("could not read rclone's version from %q: %s",
			firstLine(string(out)), RcloneInstallHint(CurrentGOOS(), true))
	}
	return version, nil
}

// parseRcloneVersion reads `rclone v1.75.1` off the first line of `rclone
// version` output. Only a line that names rclone is accepted, so a binary that
// happens to answer `version` with some other program's banner is not read as
// an rclone version. Build suffixes (`v1.75.1-002-gabc1234`, `v1.60.1-1`) are
// dropped: the three-part release is what the floor compares.
func parseRcloneVersion(out string) (string, bool) {
	for _, line := range strings.Split(out, "\n") {
		fields := strings.Fields(line)
		if len(fields) < 2 || strings.ToLower(fields[0]) != "rclone" {
			continue
		}
		token := strings.TrimPrefix(fields[1], "v")
		if i := strings.IndexAny(token, "-+"); i >= 0 {
			token = token[:i]
		}
		parts := strings.Split(token, ".")
		if len(parts) < 2 || len(parts) > 3 {
			return "", false
		}
		var cleaned []string
		for _, p := range parts {
			n, err := strconv.Atoi(p)
			if err != nil || n < 0 {
				return "", false
			}
			cleaned = append(cleaned, strconv.Itoa(n))
		}
		return strings.Join(cleaned, "."), true
	}
	return "", false
}

// compareVersions orders two dotted numeric versions, comparing each part
// numerically so 1.9 sorts above 1.10 the way a person expects and the way a
// string compare does not. A version with fewer parts is padded with zeros, so
// 1.60 and 1.60.0 compare equal.
func compareVersions(a, b string) int {
	as, bs := strings.Split(a, "."), strings.Split(b, ".")
	n := len(as)
	if len(bs) > n {
		n = len(bs)
	}
	for i := 0; i < n; i++ {
		var p, q int
		if i < len(as) {
			p, _ = strconv.Atoi(as[i])
		}
		if i < len(bs) {
			q, _ = strconv.Atoi(bs[i])
		}
		if p != q {
			if p < q {
				return -1
			}
			return 1
		}
	}
	return 0
}

// RcloneInstallHint is the sentence that says exactly what to run. It names the
// command per platform, because the person reading it is on one machine with
// one package manager, and a link alone is a second step.
//
// checkEverywhere is set when rclone was not there at all (nothing to version-
// check), and the package-manager line is the whole answer. When a too-old
// rclone was found, that line is not the whole answer, because the package
// manager's rclone is the old one: the hint then leads with the download link
// that is newer than any archive, and says why the archive is refused. The link
// stays last otherwise, where it is only the any-platform fallback.
func RcloneInstallHint(goos string, checkEverywhere bool) string {
	var b strings.Builder
	b.WriteString("Install rclone with one of these, then run this again:\n")
	if goos == "darwin" {
		b.WriteString("  brew install rclone\n")
	}
	if checkEverywhere {
		b.WriteString("  Debian or Ubuntu:  sudo apt install rclone\n")
		b.WriteString("  Fedora or RHEL:    sudo dnf install rclone\n")
		b.WriteString("  Arch:              sudo pacman -S rclone\n")
		b.WriteString("  Any platform:      https://rclone.org/downloads/ (the current build, as one .deb/.rpm/.pkg or one tar.gz)")
		return b.String()
	}
	b.WriteString("  https://rclone.org/downloads/ (the current build, as one .deb/.rpm/.pkg or one tar.gz)\n")
	b.WriteString("Your package manager's rclone may be older than this floor and is not enough on its own")
	if goos == "linux" {
		b.WriteString(": Ubuntu 24.04's rclone is 1.60.1, and the mount passes --vfs-read-chunk-streams, which rclone only added in 1.68.0. `sudo apt install rclone` (or `sudo dnf install rclone`) is worth trying only when it resolves to 1.68.0 or newer")
	}
	b.WriteString(".")
	return b.String()
}

// firstLine is the first line of a command's output, trimmed, for an error
// message. A failure is never reported with the whole output, and never with
// none of it.
func firstLine(s string) string {
	line := strings.TrimSpace(strings.SplitN(s, "\n", 2)[0])
	if line == "" {
		return "(no output)"
	}
	return line
}
