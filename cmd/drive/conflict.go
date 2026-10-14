package main

import (
	"crypto/sha256"
	"encoding/hex"
	"os"
	"os/exec"
	"runtime"
	"strings"
	"sync"
)

const conflictSeparator = " (conflict, "

// SanitizeDevice turns a device name into text that is safe inside a filename on every filesystem this product mounts.
func SanitizeDevice(name string) string {
	var b strings.Builder
	b.Grow(len(name))
	lastDash := false
	for _, r := range strings.TrimSpace(name) {
		switch {
		case r >= 'a' && r <= 'z', r >= 'A' && r <= 'Z', r >= '0' && r <= '9',
			r == '.', r == '-', r == '_':
			b.WriteRune(r)
			lastDash = r == '-'
		default:
			if lastDash || b.Len() == 0 {
				continue
			}
			b.WriteRune('-')
			lastDash = true
		}
	}
	out := strings.Trim(b.String(), "-._")
	if len(out) > maxDeviceNameLen {
		out = out[:maxDeviceNameLen]
	}
	return out
}

const maxDeviceNameLen = 64

// DefaultDeviceName is the device this mount is on when the operator did not name it: the machine's own hostname, sanitized, with a short machine suffix added when that hostname is a stock model name every Mac of the model ships with.
func DefaultDeviceName() string {
	host, err := os.Hostname()
	if err == nil {
		if name := SanitizeDevice(stockedHostname(host)); name != "" {
			return name
		}
	}
	return "device"
}

var stockHostnames = []string{
	"MacBook",
	"MacBook-Air",
	"MacBook-Pro",
	"iMac",
	"Mac-mini",
	"Mac-Studio",
	"Mac-Pro",
}

func isStockHostname(hostname string) bool {
	base := strings.ToLower(trimLocal(hostname))
	for _, model := range stockHostnames {
		model = strings.ToLower(model)
		if base == model {
			return true
		}
		if rest, ok := strings.CutPrefix(base, model+"-"); ok && isDigits(rest) {
			return true
		}
	}
	return false
}

// macOS hostnames are case-insensitive and a resolver can answer ".LOCAL".
func trimLocal(hostname string) string {
	h := strings.TrimSpace(hostname)
	if len(h) >= len(".local") && strings.EqualFold(h[len(h)-len(".local"):], ".local") {
		return h[:len(h)-len(".local")]
	}
	return h
}

func isDigits(s string) bool {
	if s == "" {
		return false
	}
	for _, r := range s {
		if r < '0' || r > '9' {
			return false
		}
	}
	return true
}

func stockedHostname(hostname string) string {
	base := trimLocal(hostname)
	if !isStockHostname(base) {
		return hostname
	}
	return base + "-" + machineSuffix()
}

var (
	machineSuffixOnce sync.Once
	machineSuffixID   string
)

func machineSuffix() string {
	machineSuffixOnce.Do(func() {
		sum := sha256.Sum256([]byte(machineID()))
		machineSuffixID = hex.EncodeToString(sum[:])[:4]
	})
	return machineSuffixID
}

func machineID() string {
	if id := platformMachineID(); id != "" {
		return id
	}
	host, err := os.Hostname()
	if err != nil || strings.TrimSpace(host) == "" {
		return "drive"
	}
	return "host:" + host
}

func platformMachineID() string {
	switch runtime.GOOS {
	case "darwin":
		// ioreg lives in /usr/sbin, which a minimal PATH can leave out.
		iorg := "/usr/sbin/ioreg"
		if _, err := os.Stat(iorg); err != nil {
			iorg = "ioreg"
		}
		out, err := exec.Command(iorg, "-rd1", "-c", "IOPlatformExpertDevice").Output()
		if err != nil {
			return ""
		}
		for _, line := range strings.Split(string(out), "\n") {
			if v, ok := strings.CutPrefix(strings.TrimSpace(line), `"IOPlatformUUID" = "`); ok {
				return strings.TrimSuffix(v, `"`)
			}
		}
		return ""
	default:
		for _, path := range []string{"/etc/machine-id", "/var/lib/dbus/machine-id"} {
			if id := readFirstLine(path); id != "" {
				return id
			}
		}
		return ""
	}
}

func readFirstLine(path string) string {
	data, err := os.ReadFile(path)
	if err != nil {
		return ""
	}
	return strings.TrimSpace(strings.SplitN(string(data), "\n", 2)[0])
}

// ConflictName is the name a losing save is kept under.
func ConflictName(remotePath, device string) string {
	dir, base := splitRemotePath(remotePath)
	stem, ext := splitFileName(base)
	return dir + stem + conflictSeparator + device + ")" + ext
}

func splitRemotePath(remotePath string) (dir, base string) {
	i := strings.LastIndex(remotePath, "/")
	if i < 0 {
		return "", remotePath
	}
	return remotePath[:i+1], remotePath[i+1:]
}

func splitFileName(name string) (stem, ext string) {
	i := strings.LastIndex(name, ".")
	if i <= 0 || i == len(name)-1 {
		return name, ""
	}
	return name[:i], name[i:]
}

// ConflictDeviceFromName reports the device that lost a save, for a filename a conflict rule produced, and false for any other name.
func ConflictDeviceFromName(name string) (string, bool) {
	_, base := splitRemotePath(name)
	stem, _ := splitFileName(base)
	i := strings.Index(stem, conflictSeparator)
	if i < 0 || !strings.HasSuffix(stem[i+len(conflictSeparator):], ")") {
		return "", false
	}
	device := strings.TrimSuffix(stem[i+len(conflictSeparator):], ")")
	if device == "" {
		return "", false
	}
	return device, true
}
