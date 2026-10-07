package rc

import (
	"errors"
	"testing"
)

// TestIsRemoteMissing pins the rule that tells a prefix rclone has not
// written yet ("no files", an answer) from a remote control that is dead (a
// real failure). It moved here from cmd/drive/conflict_test.go with the rule,
// because the rule moved with the rclone client.
func TestIsRemoteMissing(t *testing.T) {
	if !isRemoteMissing(errors.New("rclone rc operations/list: directory not found: exit status 1")) {
		t.Error("a listing of a prefix that is not in storage yet is missing")
	}
	if isRemoteMissing(errors.New("rclone rc operations/stat: object not found: exit status 1")) {
		t.Error("an object-not-found on a conflict name is not a missing prefix")
	}
	if isRemoteMissing(errors.New("rclone rc operations/list: connection refused")) {
		t.Error("a dead remote control is not a missing prefix")
	}
	if isRemoteMissing(nil) {
		t.Error("nil is not missing")
	}
}
