package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestImportPlanIsRcloneCopyIntoTheMountDir(t *testing.T) {
	home := t.TempDir()
	plan, err := BuildImportPlan("linux", home, "/usr/bin/rclone", "photos:Movies", false)
	if err != nil {
		t.Fatal(err)
	}
	wantDest := filepath.Join(home, "Drive")
	if plan.Dest != wantDest {
		t.Errorf("dest = %q, want the mount dir %q", plan.Dest, wantDest)
	}
	got := strings.Join(plan.Args(), " ")
	if got != "copy photos:Movies "+wantDest {
		t.Errorf("args = %q, want rclone copy into the mount dir", got)
	}
}

func TestImportPlanDryRunPassesRcloneItsOwnFlag(t *testing.T) {
	home := t.TempDir()
	plan, err := BuildImportPlan("linux", home, "/usr/bin/rclone", "photos:", true)
	if err != nil {
		t.Fatal(err)
	}
	got := strings.Join(plan.Args(), " ")
	if !strings.HasSuffix(got, " --dry-run") {
		t.Errorf("dry-run args = %q, want rclone's --dry-run last", got)
	}
	if strings.Count(got, "--dry-run") != 1 {
		t.Errorf("args = %q, want --dry-run once", got)
	}
}

func TestImportRefusesALocalPath(t *testing.T) {
	for _, src := range []string{"/tmp/photos", "./photos", "photos", "C:\\Users\\x", "C:/Users/x"} {
		if _, err := BuildImportPlan("linux", t.TempDir(), "/usr/bin/rclone", src, false); err == nil {
			t.Errorf("source %q: want a refusal, got none", src)
		}
	}
}

func TestImportRefusesAnEmptyOrBrokenRemote(t *testing.T) {
	for _, src := range []string{"", ":", ":path", "photos", "ph oto:x"} {
		if _, err := BuildImportPlan("linux", t.TempDir(), "/usr/bin/rclone", src, false); err == nil {
			t.Errorf("source %q: want a refusal, got none", src)
		}
	}
}

func TestRunImportNeedsASource(t *testing.T) {
	err := runImport([]string{"--home", t.TempDir()})
	if err == nil {
		t.Fatal("missing source: want a refusal")
	}
	if !strings.Contains(err.Error(), "rclone remote") && !strings.Contains(printedFailure(err), "rclone") {
		t.Errorf("missing source error = %q", printedFailure(err))
	}
}

func TestRunImportRefusesWhenNotMounted(t *testing.T) {
	home := t.TempDir()
	err := runImport([]string{"--home", home, "--rclone", "/bin/true", "photos:"})
	if err == nil {
		t.Fatal("unmounted home: want a refusal")
	}
	got := printedFailure(err)
	if !strings.Contains(got, "not mounted") {
		t.Errorf("unmounted error = %q, want not mounted", got)
	}
	if !strings.Contains(got, "drive init") {
		t.Errorf("unmounted error = %q, want drive init as the next step", got)
	}
}

func TestRunImportDrivesRcloneCopy(t *testing.T) {
	home := t.TempDir()
	log := filepath.Join(home, "rclone-argv")
	bin := filepath.Join(home, "rclone")
	script := "#!/bin/sh\n" +
		"if [ \"$1\" = \"version\" ]; then echo rclone v1.75.1; exit 0; fi\n" +
		"echo \"$*\" > " + log + "\n"
	if err := os.WriteFile(bin, []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}
	orig := importMounted
	importMounted = func(string, string) (bool, error) { return true, nil }
	t.Cleanup(func() { importMounted = orig })

	if err := runImport([]string{"--home", home, "--rclone", bin, "photos:Movies"}); err != nil {
		t.Fatal(err)
	}
	raw, err := os.ReadFile(log)
	if err != nil {
		t.Fatal(err)
	}
	got := strings.TrimSpace(string(raw))
	want := "copy photos:Movies " + filepath.Join(home, "Drive")
	if got != want {
		t.Errorf("rclone argv = %q, want %q", got, want)
	}
}

func TestUsageListsImport(t *testing.T) {
	if !strings.Contains(usage, "drive import") {
		t.Fatal("usage must list drive import")
	}
}
