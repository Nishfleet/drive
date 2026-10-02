package main

import (
	"os"
	"strings"
)

// The conflict rule (drive issue #30).
//
// Two devices edit the same file inside one sync window. rclone mounts each
// device independently, nothing coordinates them, and S3 object storage
// overwrites: whichever upload lands last wins the one plain path. That is a
// silent clobber of the other device's save.
//
// Stock rclone has no conflict-copy flag for a mount, so the rule is ours. It
// rides on two rclone interfaces the mount already speaks:
//
//   - the mount's remote control (--rc), which reports the VFS upload queue
//     (vfs/queue) — what this device has saved but storage has not taken yet;
//   - the same remote control's object operations (operations/stat,
//     operations/hashsum, operations/copyfile), which read and write the
//     bucket by name;
//
// and one fact the mount already gives us: while an upload sits in the queue,
// reading the file through the mount serves this device's own bytes, so the
// losing version can be staged from the mount before it is gone.
//
// The rule is therefore one decision per upload, taken by the losing device
// only, after its own upload has landed and the queue has released the path:
//
//	plain path = the bytes of whichever save landed last
//	name (conflict, <device>).ext = the other device's bytes, saved under
//	the losing device's own name
//
// Both versions survive and both devices can see both, so both devices are
// notified. No byte is deleted, no path is renamed, and nothing here copies a
// version that is not actually in danger: when this device's upload is the
// one that landed, nothing extra is written.

// conflictSeparator is what goes around the device name in a conflict copy:
// "notes.txt" on a device named "mac" becomes "notes (conflict, mac).txt".
const conflictSeparator = " (conflict, "

// conflictMarker names what a conflict copy is, so a listing reads as one
// thing: "report (conflict, mac).txt", "report (conflict, mac 2).txt".
const conflictMarker = "conflict"

// SanitizeDevice turns a device name into text that is safe inside a
// filename on every filesystem this product mounts. A hostname can carry
// characters a mount will not take (a macOS host's ':' becomes '/', and
// nothing in this repo theory supports that; the S3 key is even stricter),
// so anything that is not a letter, a digit, '.', '-' or '_' becomes a '-',
// runs of them collapse to one, and leading and trailing separators go. The
// result is capped, because a filename is.
//
// It is deterministic and it does not conceal anything: "John's Mac" is
// "John-s-Mac", so the device is still the one that lost the save.
func SanitizeDevice(name string) string {
	var b strings.Builder
	for _, r := range strings.TrimSpace(name) {
		switch {
		case r >= 'a' && r <= 'z', r >= 'A' && r <= 'Z', r >= '0' && r <= '9',
			r == '.', r == '-', r == '_':
			b.WriteRune(r)
		default:
			// Whitespace is the one separator that reads well in a
			// filename, so it becomes a dash rather than being dropped:
			// "Mac Studio" is "Mac-Studio". Everything else — '/', ':',
			// '*', '?', quotes, emoji — is replaced rather than dropped
			// too, so two device names cannot collapse into one.
			b.WriteRune('-')
		}
	}
	out := b.String()
	// Collapse runs of dashes and trim them, so "mac---" is "mac".
	for strings.Contains(out, "--") {
		out = strings.ReplaceAll(out, "--", "-")
	}
	out = strings.Trim(out, "-._")
	if len(out) > maxDeviceNameLen {
		out = out[:maxDeviceNameLen]
	}
	return out
}

// maxDeviceNameLen caps a device name, so the whole conflict filename stays
// inside the 255-byte limit every filesystem this product mounts enforces.
const maxDeviceNameLen = 64

// DefaultDeviceName is the device this mount is on when the operator did not
// name it: the machine's own hostname, sanitized. A mount with no hostname
// (a container without one) falls back to "device", never to an empty name,
// because a conflict file has to say which device lost the save.
func DefaultDeviceName() string {
	host, err := os.Hostname()
	if err == nil {
		if name := SanitizeDevice(host); name != "" {
			return name
		}
	}
	return "device"
}

// ConflictName is the name a losing save is kept under. The marker and the
// device name go in front of the extension and behind the stem, and nothing
// else about the name moves:
//
//	notes.txt          on "mac"    -> notes (conflict, mac).txt
//	photos/img.JPEG    on "studio-1" -> photos/img (conflict, studio-1).JPEG
//	Makefile           on "mac"    -> Makefile (conflict, mac)
//
// A name with no extension gets no empty marker at its end, and a dotfile
// such as ".env" is a whole name with no extension, not a format called
// ".env", so its marker goes at the end: ".env (conflict, mac)".
//
// The path is the remote path, which is '/'-separated whatever the host's
// filesystem does, so only the base name is rewritten and the folder stays.
func ConflictName(remotePath, device string) string {
	dir, base := splitRemotePath(remotePath)
	stem, ext := splitFileName(base)
	return dir + stem + conflictSeparator + device + ")" + ext
}

// splitRemotePath separates a '/'-separated remote path into its folder and
// its base name. A path with no '/' has an empty folder.
func splitRemotePath(remotePath string) (dir, base string) {
	i := strings.LastIndex(remotePath, "/")
	if i < 0 {
		return "", remotePath
	}
	return remotePath[:i+1], remotePath[i+1:]
}

// splitFileName splits a filename into its stem and its extension, where the
// extension is the last dot-and-what-follows-it. A name that is only a dot
// (".", "..") or only an extension (".env") has no stem to write behind, so
// it is returned whole with no extension.
func splitFileName(name string) (stem, ext string) {
	i := strings.LastIndex(name, ".")
	if i <= 0 || i == len(name)-1 {
		return name, ""
	}
	return name[:i], name[i:]
}

// ConflictDeviceFromName reports the device that lost a save, for a filename
// a conflict rule produced, and false for any other name. It is how a person
// (or a listing) reads a conflict file back, and it is also the guard against
// recursing on one: a file that is already a conflict copy is never turned
// into a conflict copy itself.
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
