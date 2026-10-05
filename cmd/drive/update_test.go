package main

import (
	"fmt"
	"io"
	"os/exec"
	"runtime/debug"
	"strings"
	"testing"
)

type fakeBin struct {
	present map[string]bool
	out     map[string]string
	err     map[string]error
	ran     []string
}

func (f *fakeBin) lookPath(name string) (string, error) {
	if f.present[name] {
		return "/bin/" + name, nil
	}
	return "", fmt.Errorf("not found: %s", name)
}

func key(name string, args []string) string {
	return name + " " + strings.Join(args, " ")
}

func (f *fakeBin) capture(name string, args []string) (string, error) {
	k := key(name, args)
	f.ran = append(f.ran, k)
	if err, ok := f.err[k]; ok {
		return f.out[k], err
	}
	if out, ok := f.out[k]; ok {
		return out, nil
	}
	return "", fmt.Errorf("unexpected command %q", k)
}

func (f *fakeBin) run(name string, args []string, out, errw io.Writer) error {
	k := key(name, args)
	f.ran = append(f.ran, k)
	if err, ok := f.err[k]; ok {
		return err
	}
	if body, ok := f.out[k]; ok {
		_, _ = io.WriteString(out, body)
		return nil
	}
	return fmt.Errorf("unexpected command %q", k)
}

func brewBins() *fakeBin {
	return &fakeBin{
		present: map[string]bool{"brew": true},
		out: map[string]string{
			"brew list --cask nish3451/tap/drive":     "drive",
			"brew outdated --cask nish3451/tap/drive": "",
			"brew upgrade --cask nish3451/tap/drive":  "",
		},
		err: map[string]error{},
	}
}

func TestUpdateHandsOffToBrew(t *testing.T) {
	f := brewBins()
	f.out["brew outdated --cask nish3451/tap/drive"] = "drive (1.0.0) < 1.1.0"
	out := new(strings.Builder)
	if err := updateDrive(updateOptions{
		from:     "0.1.0",
		lookPath: f.lookPath,
		run:      f.run,
		capture:  f.capture,
		out:      out,
		err:      io.Discard,
	}); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(out.String(), "updating drive with brew upgrade --cask nish3451/tap/drive") {
		t.Fatalf("output = %q, want the brew upgrade line", out.String())
	}
	if !strings.Contains(strings.Join(f.ran, "\n"), "brew upgrade --cask nish3451/tap/drive") {
		t.Fatalf("ran %v, want brew upgrade", f.ran)
	}
}

func TestUpdateCheckOnlyBrewUpToDate(t *testing.T) {
	f := brewBins()
	out := new(strings.Builder)
	if err := updateDrive(updateOptions{
		from:      "v1.0.0",
		checkOnly: true,
		lookPath:  f.lookPath,
		run:       f.run,
		capture:   f.capture,
		out:       out,
	}); err != nil {
		t.Fatal(err)
	}
	if got := out.String(); !strings.Contains(got, "drive is up to date (v1.0.0)") {
		t.Fatalf("--check output = %q", got)
	}
	for _, c := range f.ran {
		if strings.Contains(c, "upgrade") {
			t.Fatalf("--check must not upgrade, ran %v", f.ran)
		}
	}
}

func TestUpdateCheckOnlyBrewNewer(t *testing.T) {
	f := brewBins()
	f.out["brew outdated --cask nish3451/tap/drive"] = "drive (1.0.0) < 1.1.0"
	out := new(strings.Builder)
	if err := updateDrive(updateOptions{
		from:      "v1.0.0",
		checkOnly: true,
		lookPath:  f.lookPath,
		run:       f.run,
		capture:   f.capture,
		out:       out,
	}); err != nil {
		t.Fatal(err)
	}
	want := "a newer drive is available via brew (this machine runs v1.0.0)"
	if got := out.String(); !strings.Contains(got, want) {
		t.Fatalf("--check output = %q, want %q", got, want)
	}
}

func TestUpdateHandsOffToApt(t *testing.T) {
	f := &fakeBin{
		present: map[string]bool{"dpkg-query": true, "apt": true},
		out: map[string]string{
			"dpkg-query -W -f ${Status} drive":      "install ok installed",
			"apt list --upgradable drive":           "drive/stable 1.1.0 amd64 [upgradable from: 1.0.0]",
			"sudo apt install --only-upgrade drive": "",
		},
	}
	out := new(strings.Builder)
	if err := updateDrive(updateOptions{
		from:     "0.1.0",
		lookPath: f.lookPath,
		run:      f.run,
		capture:  f.capture,
		out:      out,
		err:      io.Discard,
	}); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(out.String(), "sudo apt install --only-upgrade drive") {
		t.Fatalf("output = %q", out.String())
	}
}

func TestUpdateHandsOffToDnf(t *testing.T) {
	f := &fakeBin{
		present: map[string]bool{"rpm": true, "dnf": true},
		out: map[string]string{
			"rpm -q drive":           "drive-1.0.0-1.x86_64",
			"sudo dnf upgrade drive": "",
		},
		err: map[string]error{
			"dnf check-update drive": &exitError100{},
		},
	}
	out := new(strings.Builder)
	if err := updateDrive(updateOptions{
		from:     "0.1.0",
		lookPath: f.lookPath,
		run:      f.run,
		capture:  f.capture,
		out:      out,
		err:      io.Discard,
	}); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(out.String(), "sudo dnf upgrade drive") {
		t.Fatalf("output = %q", out.String())
	}
}

func TestUpdateHandsOffToWinget(t *testing.T) {
	f := &fakeBin{
		present: map[string]bool{"winget": true},
		out: map[string]string{
			"winget list --id Nishfleet.Drive --disable-interactivity":                     "Nishfleet.Drive 1.0.0",
			"winget list --id Nishfleet.Drive --disable-interactivity --upgrade-available": "Nishfleet.Drive 1.0.0",
			"winget upgrade --id Nishfleet.Drive --disable-interactivity":                  "",
		},
	}
	out := new(strings.Builder)
	if err := updateDrive(updateOptions{
		from:     "0.1.0",
		lookPath: f.lookPath,
		run:      f.run,
		capture:  f.capture,
		out:      out,
		err:      io.Discard,
	}); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(out.String(), "winget upgrade --id Nishfleet.Drive") {
		t.Fatalf("output = %q", out.String())
	}
}

type exitError100 struct{}

func (e *exitError100) Error() string { return "exit status 100" }
func (e *exitError100) ExitCode() int { return 100 }

func TestUpdateCheckOnlyDnfNewer(t *testing.T) {
	f := &fakeBin{
		present: map[string]bool{"rpm": true, "dnf": true},
		out: map[string]string{
			"rpm -q drive": "drive-1.0.0-1.x86_64",
		},
		err: map[string]error{
			"dnf check-update drive": &exitError100{},
		},
	}
	out := new(strings.Builder)
	if err := updateDrive(updateOptions{
		from:      "v1.0.0",
		checkOnly: true,
		lookPath:  f.lookPath,
		run:       f.run,
		capture:   f.capture,
		out:       out,
	}); err != nil {
		t.Fatal(err)
	}
	if got := out.String(); !strings.Contains(got, "a newer drive is available via dnf") {
		t.Fatalf("--check output = %q", got)
	}
}

func TestUpdateUnknownInstallNamesTheInstallLines(t *testing.T) {
	f := &fakeBin{present: map[string]bool{}}
	err := updateDrive(updateOptions{
		lookPath: f.lookPath,
		run:      f.run,
		capture:  f.capture,
		out:      io.Discard,
		err:      io.Discard,
	})
	if err == nil {
		t.Fatal("an unknown install must be an error")
	}
	for _, line := range []string{brewInstallLine, aptInstallLine, dnfInstallLine, "winget install " + wingetPackageID} {
		if !strings.Contains(err.Error(), line) {
			t.Fatalf("error %v must name %q", err, line)
		}
	}
}

func TestUpdateDoesNotUpgradeWhenUpToDate(t *testing.T) {
	f := brewBins()
	out := new(strings.Builder)
	if err := updateDrive(updateOptions{
		from:     "v1.0.0",
		lookPath: f.lookPath,
		run:      f.run,
		capture:  f.capture,
		out:      out,
		err:      io.Discard,
	}); err != nil {
		t.Fatal(err)
	}
	if got := out.String(); !strings.Contains(got, "drive is up to date (v1.0.0)") {
		t.Fatalf("output = %q", got)
	}
	for _, c := range f.ran {
		if strings.Contains(c, "upgrade") {
			t.Fatalf("an up-to-date machine must not upgrade, ran %v", f.ran)
		}
	}
}

func TestUpdateAptUpToDateNamesTheDebLine(t *testing.T) {
	f := &fakeBin{
		present: map[string]bool{"dpkg-query": true, "apt": true},
		out: map[string]string{
			"dpkg-query -W -f ${Status} drive": "install ok installed",
			"apt list --upgradable drive":      "Listing...",
		},
	}
	out := new(strings.Builder)
	if err := updateDrive(updateOptions{
		from:     "v1.0.0",
		lookPath: f.lookPath,
		run:      f.run,
		capture:  f.capture,
		out:      out,
		err:      io.Discard,
	}); err != nil {
		t.Fatal(err)
	}
	if got := out.String(); !strings.Contains(got, aptInstallLine) {
		t.Fatalf("output = %q, want the downloaded-deb install line", got)
	}
	for _, c := range f.ran {
		if strings.Contains(c, "sudo") {
			t.Fatalf("must not run sudo when apt has no upgrade, ran %v", f.ran)
		}
	}
}

func TestUpdateDefaultsTheWriters(t *testing.T) {
	f := brewBins()
	if err := updateDrive(updateOptions{
		from:      "v1.0.0",
		checkOnly: true,
		lookPath:  f.lookPath,
		run:       f.run,
		capture:   f.capture,
	}); err != nil {
		t.Fatal(err)
	}
}

func TestUpdateFailsWhenUpgradeFails(t *testing.T) {
	f := brewBins()
	f.out["brew outdated --cask nish3451/tap/drive"] = "drive (1.0.0) < 1.1.0"
	f.err["brew upgrade --cask nish3451/tap/drive"] = fmt.Errorf("brew failed")
	err := updateDrive(updateOptions{
		from:     "0.1.0",
		lookPath: f.lookPath,
		run:      f.run,
		capture:  f.capture,
		out:      io.Discard,
		err:      io.Discard,
	})
	if err == nil {
		t.Fatal("a failed upgrade must be an error")
	}
	if !strings.Contains(err.Error(), "brew") {
		t.Fatalf("the error should name brew, got: %v", err)
	}
}

// TestUpdateOffersTheRcloneUpdateWhenBelowTheFloor is drive#560's offer half
// of bullet 3: the binary replaced itself, and an rclone below
// MinRcloneVersion makes the mount's own flags fail (drive#105), so the update
// is the moment that says so. The offer runs through the real CheckRclone, with
// a stand-in rclone binary, so a mock cannot decide what the words are. The
// restart stays off: a unit test may not restart this machine's real mount.
func TestUpdateOffersTheRcloneUpdateWhenBelowTheFloor(t *testing.T) {
	f := brewBins()
	f.out["brew outdated --cask nish3451/tap/drive"] = "drive (1.0.0) < 1.1.0"
	out := new(strings.Builder)
	if err := updateDrive(updateOptions{
		from:     "0.1.0",
		lookPath: f.lookPath,
		run:      f.run,
		capture:  f.capture,
		rclone:   writeFakeRclone(t, "rclone v1.60.1\n- os/version: ubuntu 24.04\n"),
		home:     t.TempDir(),
		out:      out,
		err:      io.Discard,
	}); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(out.String(), "updated drive 0.1.0") {
		t.Fatalf("output = %q, want the upgraded-version line", out.String())
	}
	for _, want := range []string{"rclone 1.60.1 is too old", MinRcloneVersion, RcloneInstallHint(CurrentGOOS(), false)} {
		if !strings.Contains(out.String(), want) {
			t.Errorf("the update must offer the rclone fix with %q, got %q", want, out.String())
		}
	}
}

// TestUpdateDoesNotRestartAMountOnAMachineWithoutOne runs the production path
// (`drive update` sets restartMount) against a home directory with no mount in
// it, which is what most machines are. It proves the new restart step restarts
// nothing and fails nothing there, so adding it cannot break an update that
// used to work.
func TestUpdateDoesNotRestartAMountOnAMachineWithoutOne(t *testing.T) {
	f := brewBins()
	f.out["brew outdated --cask nish3451/tap/drive"] = "drive (1.0.0) < 1.1.0"
	out := new(strings.Builder)
	if err := updateDrive(updateOptions{
		from:         "0.1.0",
		lookPath:     f.lookPath,
		run:          f.run,
		capture:      f.capture,
		rclone:       writeFakeRclone(t, "rclone v1.75.1\n- os/version: ubuntu 24.04\n"),
		home:         t.TempDir(),
		restartMount: true,
		out:          out,
		err:          io.Discard,
	}); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(out.String(), "updated drive 0.1.0") {
		t.Fatalf("output = %q, want the upgraded-version line", out.String())
	}
	if strings.Contains(out.String(), "mount restarted") {
		t.Fatalf("a machine with no mount up must not report a restart, got %q", out.String())
	}
	if strings.Contains(out.String(), "too old") {
		t.Fatalf("an rclone at the floor must not be offered an update, got %q", out.String())
	}
}

func TestModuleVersionEmptyAndDevel(t *testing.T) {
	if got := moduleVersion(&debug.BuildInfo{Main: debug.Module{Version: ""}}); got != "" {
		t.Fatalf("empty version = %q", got)
	}
	if got := moduleVersion(&debug.BuildInfo{Main: debug.Module{Version: "(devel)"}}); got != "" {
		t.Fatalf("devel version = %q", got)
	}
	if got := moduleVersion(&debug.BuildInfo{Main: debug.Module{Version: "v1.2.3"}}); got != "v1.2.3" {
		t.Fatalf("released version = %q", got)
	}
}

// A binary built from a checkout, with the version-control stamping off, has
// no module version in it, so `drive version` falls back to the source-tree
// version.
func TestDriveVersionFallbackForACheckoutBuild(t *testing.T) {
	if _, err := exec.LookPath("go"); err != nil {
		t.Skip("go not on PATH")
	}
	bin := t.TempDir() + "/drive"
	cmd := exec.Command("go", "build", "-buildvcs=false", "-o", bin, ".")
	if raw, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("go build: %v\n%s", err, raw)
	}
	v, err := binaryVersionAt(bin)
	if err != nil {
		t.Fatal(err)
	}
	if v != "0.1.0" {
		t.Fatalf("a checkout build reports %q, want the source-tree version 0.1.0", v)
	}
}

// A binary built from a dirty checkout carries the toolchain's own
// pseudo-version, which is that binary's real identity.
func TestDriveVersionReportsTheWorkingTreeVersion(t *testing.T) {
	if _, err := exec.LookPath("go"); err != nil {
		t.Skip("go not on PATH")
	}
	v, err := binaryVersionAt(driveBin(t))
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(v, "v0.0.0-") {
		t.Skipf("this build recorded %q, not a working-tree pseudo-version", v)
	}
}
