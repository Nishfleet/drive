package main

import (
	"os"
	"os/exec"
	"strings"
	"testing"
)

// probeEnv is the probe child's whole environment. The child is this same test
// binary re-exec'd against skipNoMount, and it needs nothing but the paths and
// its own variables: the runner's own credentials never reach it, because a
// process on this host is the one thing they must not travel sideways into.
func probeEnv(probe string) []string {
	out := []string{}
	for _, name := range []string{"PATH", "HOME", "TMPDIR"} {
		if v := os.Getenv(name); v != "" {
			out = append(out, name+"="+v)
		}
	}
	return append(out, "DRIVE_SKIPNOMOUNT_PROBE="+probe)
}

func TestSkipNoMountFailsUnderCI(t *testing.T) {
	if os.Getenv("DRIVE_SKIPNOMOUNT_PROBE") == "fail" {
		skipNoMount(t, "the host does not permit an unprivileged FUSE mount")
		return
	}
	// CI=true is what GitHub Actions and `npm ci` set.
	cmd := exec.Command(os.Args[0], "-test.run=^TestSkipNoMountFailsUnderCI$", "-test.v")
	cmd.Env = append(probeEnv("fail"), "CI=true")
	out, err := cmd.CombinedOutput()
	if err == nil {
		t.Fatalf("want a failure under CI=true, got success:\n%s", out)
	}
	got := string(out)
	if !strings.Contains(got, "a FUSE skip is a failure under CI=true") {
		t.Fatalf("want the CI failure line, got:\n%s", out)
	}
	if !strings.Contains(got, "the host does not permit an unprivileged FUSE mount") {
		t.Fatalf("want the host's own reason inside the failure, got:\n%s", out)
	}
}

// CI=false is what a shell exports to switch CI off, so it must still skip: an
// exact comparison, not "set to anything".
func TestSkipNoMountSkipsWhenCIIsFalse(t *testing.T) {
	if os.Getenv("DRIVE_SKIPNOMOUNT_PROBE") == "not-ci" {
		skipNoMount(t, "the host does not permit an unprivileged FUSE mount")
		return
	}
	cmd := exec.Command(os.Args[0], "-test.run=^TestSkipNoMountSkipsWhenCIIsFalse$", "-test.v")
	cmd.Env = append(probeEnv("not-ci"), "CI=false")
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("want a skip under CI=false, got %v:\n%s", err, out)
	}
	got := string(out)
	if !strings.Contains(got, "--- SKIP: TestSkipNoMountSkipsWhenCIIsFalse") {
		t.Fatalf("want this test reported as skipped, got:\n%s", out)
	}
}

func TestSkipNoMountSkipsWithoutCI(t *testing.T) {
	if os.Getenv("DRIVE_SKIPNOMOUNT_PROBE") == "skip" {
		skipNoMount(t, "the host does not permit an unprivileged FUSE mount")
		return
	}
	cmd := exec.Command(os.Args[0], "-test.run=^TestSkipNoMountSkipsWithoutCI$", "-test.v")
	cmd.Env = probeEnv("skip")
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("want a skip without CI, got %v:\n%s", err, out)
	}
	got := string(out)
	if !strings.Contains(got, "--- SKIP: TestSkipNoMountSkipsWithoutCI") {
		t.Fatalf("want this test reported as skipped, got:\n%s", out)
	}
}
