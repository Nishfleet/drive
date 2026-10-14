package main

import (
	"errors"
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

func TestImportPlanStopsAtTheCacheCap(t *testing.T) {
	plan, err := BuildImportPlan("linux", t.TempDir(), "/usr/bin/rclone", "photos:", false)
	if err != nil {
		t.Fatal(err)
	}
	plan.MaxBytes = 1 << 30
	args := plan.Args()
	if !hasArgPair(args, "--max-transfer", "1073741824") {
		t.Errorf("args = %v, want --max-transfer at the headroom", args)
	}
	if !hasArgPair(args, "--cutoff-mode", "soft") {
		t.Errorf("args = %v, want --cutoff-mode soft so the copy stops rather than errors at the cap", args)
	}
	plan.MaxBytes = 0
	if strings.Contains(strings.Join(plan.Args(), " "), "--max-transfer") {
		t.Errorf("args = %v, must not cap a copy with no headroom", plan.Args())
	}
}

func TestImportStopRefusesAPastTheCapCache(t *testing.T) {
	maxBytes, err := importStop(cacheHeadroom{CapBytes: 20 << 30, UsedBytes: 4 << 30}, true)
	if err != nil {
		t.Fatalf("room under the cap: %v", err)
	}
	if maxBytes != 16<<30 {
		t.Errorf("maxBytes = %d, want the 16 GiB headroom", maxBytes)
	}
	_, err = importStop(cacheHeadroom{CapBytes: 20 << 30, UsedBytes: 20 << 30}, true)
	if err == nil {
		t.Fatal("a cache at its cap must stop the import")
	}
	if !strings.Contains(printedFailure(err), "cache is full") {
		t.Errorf("stop = %q, want the cache-full words", printedFailure(err))
	}
	if maxBytes, err := importStop(cacheHeadroom{}, false); err != nil || maxBytes != 0 {
		t.Errorf("unanswered mount = (%d, %v), want (0, nil)", maxBytes, err)
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
	origHeadroom := importCacheHeadroom
	importCacheHeadroom = func(string) (cacheHeadroom, bool, error) { return cacheHeadroom{}, false, nil }
	t.Cleanup(func() {
		importMounted = orig
		importCacheHeadroom = origHeadroom
	})

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

func TestImportIntoWindowsTargetsTheVolumeRoot(t *testing.T) {
	orig := windowsImportDest
	t.Cleanup(func() { windowsImportDest = orig })
	const letter = "D:"
	windowsImportDest = func() (string, error) {
		return windowsVolumeRoot(letter), nil
	}

	home := t.TempDir()
	plan, err := BuildImportPlan("windows", home, "/usr/bin/rclone", "photos:Movies", false)
	if err != nil {
		t.Fatal(err)
	}
	if want := `D:\`; plan.Dest != want {
		t.Errorf("dest = %q, want the volume root %q", plan.Dest, want)
	}
	if got, want := strings.Join(plan.Args(), " "), `copy photos:Movies D:\`; got != want {
		t.Errorf("args = %q, want rclone copy into the volume root %q", got, want)
	}
	for _, tc := range []struct{ letter, want string }{
		{"D:", `D:\`},
		{`D:\`, `D:\`},
		{"E:", `E:\`},
	} {
		if got := windowsVolumeRoot(tc.letter); got != tc.want {
			t.Errorf("windowsVolumeRoot(%q) = %q, want %q", tc.letter, got, tc.want)
		}
	}
}

func TestImportIntoWindowsSurfacesTheLetterLookupFailure(t *testing.T) {
	orig := windowsImportDest
	t.Cleanup(func() { windowsImportDest = orig })
	windowsImportDest = func() (string, error) { return "", errors.New("schtasks: not found") }
	if _, err := BuildImportPlan("windows", t.TempDir(), "/usr/bin/rclone", "photos:", false); err == nil {
		t.Fatal("expected the letter lookup failure to reach the caller")
	}
}
