package main

// The CLI's one message table (drive#117, the CLI side of src/messages.js
// FAILURE_MESSAGES). Every error a person can read comes from this table and
// carries two things:
//
//	what - what happened, in one plain sentence.
//	next - the exact next command or action, in one sentence.
//
// No raw rclone or storage error reaches the terminal: the underlying detail
// stays in the failure's detail (shown only with DRIVE_DEBUG=1) or in the
// mount's own log, and the next step names where to look. The words for the
// failures the drive has on every surface are copied from src/messages.js so
// the CLI and the pages say the same thing; test/messages.test.mjs keeps that
// table honest on the web side, and TestSharedKindsMatchThePageTable pins the
// join here. Everything else is a CLI-shaped failure whose next step is an
// exact command.
//
// Entries carry {1}, {2}... placeholders for the call's own values (the
// missing settings, the log path, the tool name). A placeholder that an entry
// does not use stays untouched, so what and next never have to want the same
// values.

import (
	"errors"
	"fmt"
	"io"
	"os"
	"strconv"
	"strings"
)

// failure is one entry of the message table, bound to a failure site. detail
// is the underlying error, kept for DRIVE_DEBUG and for errors.As callers;
// it is never printed by default (north star "Safe": no raw error text).
type failure struct {
	Kind    string
	What    string
	Next    string
	service string // the api Worker's own sentence, when there is one
	detail  error  // kept for DRIVE_DEBUG and for errors.As callers
}

// withService attaches the api Worker's own sentence (docs/api.md: errors are
// {error: <sentence>}). That sentence is the product's own words, written for
// a person, so it is shown between what happened and the next step; the raw
// status line stays in the detail.
func (f *failure) withService(sentence string) *failure {
	f.service = sentence
	return f
}

// Error returns what happened, the service's own sentence when there is one,
// and the next step, so any code path that prints the error with %v still
// shows a person everything they need.
func (f *failure) Error() string {
	parts := []string{f.What}
	if f.service != "" {
		parts = append(parts, "The api said: "+f.service)
	}
	if f.Next != "" {
		parts = append(parts, "Next: "+f.Next)
	}
	return strings.Join(parts, " ")
}

// Unwrap exposes the underlying error to errors.Is and errors.As.
func (f *failure) Unwrap() error { return f.detail }

// messageTable is the table itself: kind -> what happened, next step. A kind
// is added here before any call site can use it, and
// TestFailureTableIsComplete holds every entry to the two-sentence shape.
var messageTable = map[string][2]string{
	// The five kinds the drive shares with the web pages. Their what lines
	// are the src/messages.js words; TestSharedKindsMatchThePageTable pins
	// them together.
	"offline": {
		"You look offline.",
		"Check your connection and try again.",
	},
	"key-revoked": {
		"This device's key was revoked, so it can't reach the drive.",
		"Run `drive init` to sign in again to get a new key; your files are untouched.",
	},
	"storage-down": {
		"We can't reach storage right now.",
		"Wait a few minutes and run the command again.",
	},
	"cap-reached": {
		"Your drive is read-only because it reached its spending cap; nothing was deleted.",
		"Raise the cap on the usage page to start writing again.",
	},
	"disk-cache-full": {
		"The local cache is full, so new saves can't upload.",
		"Free up disk space on this device and try the save again.",
	},
	"unexpected": {
		"That did not work.",
		"Try again in a moment; if it fails again, run `drive status` and keep its output.",
	},

	// CLI-shaped failures: the next step is an exact command.
	"no-api": {
		"No drive api is configured.",
		"Run the command again with `--api <url>`, or set the DRIVE_API_URL environment variable.",
	},
	"api-url": {
		"{1} is not a working drive api address.",
		"Pass the address as `--api <url>` (http or https), then run the command again.",
	},
	"api-answer": {
		"The drive's api sent an answer that could not be read.",
		"Run the command again in a moment; if it repeats, the api is down.",
	},
	"api-refused": {
		"The drive's api refused the request.",
		"Run `drive init` again; if it repeats, run `drive status` and keep its output.",
	},
	"api-down": {
		"The drive's api is not answering right now.",
		"Wait a few minutes and run the command again.",
	},
	"no-api-for-key": {
		"{1} has an agent key, but this device has no drive api to revoke it from.",
		"Run `drive agents revoke {1}` again with `--api <url>`, or set the DRIVE_API_URL environment variable.",
	},
	"sign-in-expired": {
		"The sign-in code expired before it was approved.",
		"Run `drive init` again for a new code.",
	},
	"not-signed-in": {
		"This device is not signed in to the drive.",
		"Run `drive init` to sign in, then run the command again.",
	},
	"no-rclone": {
		"rclone is not installed; the drive mounts with rclone.",
		"Install it (macOS: `brew install rclone`; Linux: `sudo apt install rclone`) or point `--rclone` at the binary, then run `drive mount` again.",
	},
	"missing-config": {
		"The drive is missing its storage settings: {1}.",
		"Set them and run `drive mount` again: `drive mount --endpoint <url> --bucket <bucket> --prefix <prefix>` with DRIVE_S3_ACCESS_KEY_ID and DRIVE_S3_SECRET_ACCESS_KEY in the environment.",
	},
	"invalid-config": {
		"The {1} has a newline or NUL in it, which would corrupt the rclone config.",
		"Fix the {1} value, then run `drive mount` again.",
	},
	"bad-prefix": {
		"The prefix {1} walks out of this device's own folder.",
		"Use the prefix this device owns (for example `u/<your-account>`), then run `drive mount` again.",
	},
	"drive-folder": {
		"The drive folder {1} could not be created.",
		"Check that the disk has room and that {1} is writable, then run the command again.",
	},
	"mount-failed": {
		"rclone exited before the drive mounted.",
		"Read {1} for the exact cause, fix it, then run `drive mount` again.",
	},
	"mount-hung": {
		"The mount did not come up within {1}.",
		"Look for the cause in {2}, then run `drive status` and, when it is fixed, `drive mount` again.",
	},
	"login-item": {
		"The login item did not start the mount.",
		"Read the cause (`journalctl --user -u drive-mount.service` on Linux, `~/.config/drive/mount.log` on macOS), then run `drive mount` again.",
	},
	"unmount-failed": {
		"The drive at {1} did not come down.",
		"Unmount it by hand (Linux: `fusermount3 -u {1}`; macOS: `sudo umount {1}`), then run the command again.",
	},
	"logout-leftover": {
		"Logout finished, but {1} is still on disk.",
		"Delete {1} by hand, then run `drive status` to confirm the drive is gone.",
	},
	"uploads-stuck": {
		"{1} file(s) are still waiting to upload ({2} bytes).",
		"Start the mount and let them finish, or run `drive logout --force` to discard them.",
	},
	"key-still-live": {
		"signed out here; the key is still live, run drive logout again when online",
		"Run `drive logout` again when you are online, with `--api <url>` or DRIVE_API_URL set.",
	},
	"key-still-live-elsewhere": {
		"signed out here; a key from an earlier logout is still live and this device no longer has it; revoke it from the devices page in the web app, then run drive logout --forget-pending",
		"Revoke it from the devices page in the web app, then run `drive logout --forget-pending`.",
	},
	"queue-unreadable": {
		"The upload queue could not be read ({1}).",
		"Leave the mount running so queued files keep uploading, then run `drive status` again in a moment.",
	},
	"folder-silent": {
		"The drive folder did not answer within {1}.",
		"Read {2}, then run `drive unmount` and `drive mount` again.",
	},
	"tool-not-installed": {
		"{1} is not installed on this machine.",
		"Install {1}, then run `drive agents connect {1}`.",
	},
	"unknown-tool": {
		"There is no agent tool named {1}.",
		"Pick one of {2}, or run `drive agents` to list them.",
	},
	"tool-failed": {
		"{1} agent tool(s) could not be connected.",
		"Fix the causes printed above, then run `drive agents connect <tool>` for each one.",
	},
}

// fail builds a table failure with no call values and no underlying detail.
func fail(kind string) *failure { return failDetail(kind, nil) }

// failf builds a table failure; the values replace {1}, {2}... in the entry's
// what and next wherever they appear.
func failf(kind string, args ...string) *failure { return failDetail(kind, nil, args...) }

// failDetail builds a table failure and keeps the underlying error for
// DRIVE_DEBUG. An empty detail is passed through as nil.
func failDetail(kind string, detail error, args ...string) *failure {
	entry, ok := messageTable[kind]
	if !ok {
		// A kind missing from the table is a programmer error, the same way
		// failureMessage throws in src/messages.js. The CLI still has to print
		// a next step rather than crash, so it falls back to unexpected and
		// keeps the missing kind in the detail for DRIVE_DEBUG=1.
		missing := fmt.Errorf("no message table entry for %q", kind)
		if detail != nil {
			missing = fmt.Errorf("no message table entry for %q: %w", kind, detail)
		}
		fallback := messageTable["unexpected"]
		return &failure{
			Kind:   "unexpected",
			What:   fallback[0],
			Next:   fallback[1],
			detail: missing,
		}
	}
	return &failure{Kind: kind, What: fill(entry[0], args), Next: fill(entry[1], args), detail: detail}
}

// fill replaces {1}, {2}... with the call's values, left to right.
func fill(template string, args []string) string {
	if len(args) == 0 {
		return template
	}
	pairs := make([]string, 0, 2*len(args))
	for i, v := range args {
		pairs = append(pairs, "{"+strconv.Itoa(i+1)+"}", v)
	}
	return strings.NewReplacer(pairs...).Replace(template)
}

// debugDetail reports whether the underlying error may be shown.
func debugDetail() bool { return os.Getenv("DRIVE_DEBUG") == "1" }

// printFailure writes err to w the way main shows it: what happened, then the
// next step. A failure's underlying detail is shown only with DRIVE_DEBUG=1;
// an error that is not in the table prints the unexpected entry plus a
// marker, so an unclassified failure can never pass for a table entry.
// It returns the process exit code (always 1).
func printFailure(w io.Writer, err error) int {
	var f *failure
	if !errors.As(err, &f) {
		fallback := failDetail("unexpected", err)
		fmt.Fprintf(w, "drive: %s\n", fallback.What)
		fmt.Fprintf(w, "  next: %s\n", fallback.Next)
		fmt.Fprintf(w, "  (this failure has no message table entry; run with DRIVE_DEBUG=1 to see the detail)\n")
		if debugDetail() {
			fmt.Fprintf(w, "  detail: %v\n", err)
		}
		return 1
	}
	fmt.Fprintf(w, "drive: %s\n", f.What)
	if f.service != "" {
		fmt.Fprintf(w, "  the api said: %s\n", f.service)
	}
	fmt.Fprintf(w, "  next: %s\n", f.Next)
	if debugDetail() && f.detail != nil {
		fmt.Fprintf(w, "  detail: %v\n", f.detail)
	}
	return 1
}

// apiFailureKind names the message table kind for a failed api Worker call:
// the Worker's own refusals (APIError) split by status, anything else is the
// network. err is never nil at a call site.
func apiFailureKind(err error) string {
	var apiErr *APIError
	if errors.As(err, &apiErr) {
		if strings.Contains(apiErr.Status, "401") || strings.Contains(apiErr.Status, "403") {
			return "key-revoked"
		}
		return "api-refused"
	}
	return "offline"
}
