package main

import (
	"os"
	"os/exec"
	"strings"
	"testing"
)

func envWithoutCI() []string {
	out := make([]string, 0, len(os.Environ()))
	for _, e := range os.Environ() {
		if strings.HasPrefix(e, "CI=") {
			continue
		}
		out = append(out, e)
	}
	return out
}

func TestSkipNoMountFailsUnderCI(t *testing.T) {
	if os.Getenv("DRIVE_SKIPNOMOUNT_PROBE") == "fail" {
		skipNoMount(t, "the host does not permit an unprivileged FUSE mount")
		return
	}
	cmd := exec.Command(os.Args[0], "-test.run=^TestSkipNoMountFailsUnderCI$", "-test.v")
	cmd.Env = append(os.Environ(), "DRIVE_SKIPNOMOUNT_PROBE=fail", "CI=true")
	out, err := cmd.CombinedOutput()
	if err == nil {
		t.Fatalf("want a failure under CI=true, got success:\n%s", out)
	}
	got := string(out)
	if !strings.Contains(got, "a FUSE skip is a failure under CI=true") {
		t.Fatalf("want the CI failure line, got:\n%s", got)
	}
}

func TestSkipNoMountSkipsWithoutCI(t *testing.T) {
	if os.Getenv("DRIVE_SKIPNOMOUNT_PROBE") == "skip" {
		skipNoMount(t, "the host does not permit an unprivileged FUSE mount")
		return
	}
	cmd := exec.Command(os.Args[0], "-test.run=^TestSkipNoMountSkipsWithoutCI$", "-test.v")
	cmd.Env = append(envWithoutCI(), "DRIVE_SKIPNOMOUNT_PROBE=skip")
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("want a skip without CI, got %v:\n%s", err, out)
	}
	got := string(out)
	if !strings.Contains(got, "SKIP") {
		t.Fatalf("want SKIP without CI, got:\n%s", got)
	}
}
