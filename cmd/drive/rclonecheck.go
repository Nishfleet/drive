package main

import (
	"fmt"
	"os/exec"
	"strconv"
	"strings"
)

// MinRcloneVersion is the oldest rclone a drive mount is proven on. It is not
// a number read off a changelog: it is the version Ubuntu 24.04 LTS ships in
// its archive, which is the one the packaged install pulls in, because the
// .deb carries `Depends: rclone` (.goreleaser.yaml's nfpms stanza) and the
// package manager resolves that to the archive's own. The one-line install in
// docs-site/quickstart.md was run on that exact version in the PR's container
// proof, so the floor is measured at the point the documented path delivers.
//
// Raise it only with a measured reason: a documented flag the old rclone
// refuses, or a mount proof that fails on the version below.
const MinRcloneVersion = "1.60.0"

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
		return fmt.Errorf("%w\n%s", err, RcloneInstallHint(goos))
	}
	if compareVersions(version, MinRcloneVersion) >= 0 {
		return nil
	}
	return fmt.Errorf("rclone %s is too old: drive mounts need rclone %s or newer\n%s",
		version, MinRcloneVersion, RcloneInstallHint(goos))
}

// InstalledRcloneVersion runs the rclone binary and reads the version from its
// first line of output: `rclone v1.75.1` on the first line, then os/version and
// os/kernel. A binary that prints nothing parsable is reported with what it
// did print, because a too-old build and a broken build need different fixes.
func InstalledRcloneVersion(rcloneBin string) (string, error) {
	out, err := exec.Command(rcloneBin, "version").CombinedOutput()
	if err != nil {
		return "", fmt.Errorf("rclone version: %w: %s", err, firstLine(string(out)))
	}
	version, ok := parseRcloneVersion(string(out))
	if !ok {
		return "", fmt.Errorf("could not read rclone's version from %q: %s",
			firstLine(string(out)), RcloneInstallHint(CurrentGOOS()))
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
// one package manager, and a link alone is a second step. The download link is
// last: it is the answer on any platform, and the fallback when the packaged
// version is too old to satisfy the floor.
func RcloneInstallHint(goos string) string {
	var b strings.Builder
	b.WriteString("Install rclone with one of these, then run this again:\n")
	if goos == "darwin" {
		b.WriteString("  brew install rclone\n")
	}
	b.WriteString("  Debian or Ubuntu:  sudo apt install rclone\n")
	b.WriteString("  Fedora or RHEL:    sudo dnf install rclone\n")
	b.WriteString("  Arch:              sudo pacman -S rclone\n")
	b.WriteString("  Any platform:      https://rclone.org/downloads/ (the current build, as one .deb/.rpm/.pkg or one tar.gz)")
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
