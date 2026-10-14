package main

import (
	"fmt"
	"os/exec"
	"strconv"
	"strings"
)

// MinRcloneVersion is the oldest rclone a drive mount is proven on.
const MinRcloneVersion = "1.68.0"

// CheckRclone runs `<rclone> version` and fails loudly when the binary is missing or older than MinRcloneVersion.
func CheckRclone(goos, rcloneBin string) error {
	version, err := InstalledRcloneVersion(rcloneBin)
	if err != nil {
		return fmt.Errorf("%w\n%s", err, RcloneInstallHint(goos, true))
	}
	if compareVersions(version, MinRcloneVersion) >= 0 {
		return nil
	}
	return fmt.Errorf("rclone %s is too old: drive mounts need rclone %s or newer\n%s",
		version, MinRcloneVersion, RcloneInstallHint(goos, false))
}

// InstalledRcloneVersion runs the rclone binary and reads the version from its first line of output: `rclone v1.75.1` on the first line, then os/version and os/kernel.
func InstalledRcloneVersion(rcloneBin string) (string, error) {
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

// RcloneInstallHint is the sentence that says exactly what to run.
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

func firstLine(s string) string {
	line := strings.TrimSpace(strings.SplitN(s, "\n", 2)[0])
	if line == "" {
		return "(no output)"
	}
	return line
}
