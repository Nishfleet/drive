package main

import (
	"archive/zip"
	"encoding/json"
	"io"
	"io/fs"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

// makeProxyZip writes a module-proxy zip of this repository's drive module,
// tagged v0.9.9, into t.TempDir() and returns the zip path. The layout is the
// module-proxy protocol's, so a real `go install` can fetch a tagged version
// of this module through localProxy below, and the update test exercises the
// whole install path instead of a stub of it. The module source in the zip is
// the working tree's cmd/drive (minus _test.go files, which a build does not
// need), so the installed binary is this package.
func makeProxyZip(t *testing.T) string {
	t.Helper()
	const (
		ver    = "v0.9.9"
		prefix = "github.com/Nishfleet/drive@" + ver
	)
	modDir := filepath.Join(t.TempDir(), "github.com", "!nishfleet", "drive", "@v")
	if err := os.MkdirAll(modDir, 0o755); err != nil {
		t.Fatal(err)
	}
	infoJSON, err := json.Marshal(struct{ Version string }{Version: ver})
	if err != nil {
		t.Fatal(err)
	}
	gomod, err := os.ReadFile(filepath.Join("..", "..", "go.mod"))
	if err != nil {
		t.Fatal(err)
	}
	files := map[string][]byte{
		"list":        []byte(ver + "\n"),
		ver + ".info": infoJSON,
		ver + ".mod":  gomod,
	}
	names, err := os.ReadDir(".")
	if err != nil {
		t.Fatal(err)
	}
	zp := filepath.Join(modDir, ver+".zip")
	z, err := os.Create(zp)
	if err != nil {
		t.Fatal(err)
	}
	zw := zip.NewWriter(z)
	for _, d := range []string{prefix + "/", prefix + "/cmd/", prefix + "/cmd/drive/"} {
		if _, err := zw.Create(d); err != nil {
			t.Fatal(err)
		}
	}
	write := func(name string, body []byte) {
		t.Helper()
		w, err := zw.Create(name)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := w.Write(body); err != nil {
			t.Fatal(err)
		}
	}
	write(prefix+"/go.mod", gomod)
	for _, n := range names {
		if n.IsDir() || !strings.HasSuffix(n.Name(), ".go") || strings.HasSuffix(n.Name(), "_test.go") {
			continue
		}
		body, err := os.ReadFile(n.Name())
		if err != nil {
			t.Fatal(err)
		}
		write(prefix+"/cmd/drive/"+n.Name(), body)
	}
	if err := zw.Close(); err != nil {
		t.Fatal(err)
	}
	if err := z.Close(); err != nil {
		t.Fatal(err)
	}
	for name, body := range files {
		if err := os.WriteFile(filepath.Join(modDir, name), body, 0o644); err != nil {
			t.Fatal(err)
		}
	}
	return zp
}

// localProxy serves a module-proxy directory over HTTP: the zip at zipPath,
// plus the list/info/mod files beside it, and a 404 for anything else (which
// is how the toolchain learns to fall back from the package path to the module
// root). It returns the server URL and a cleanup function.
func localProxy(t *testing.T, zipPath string) (string, func()) {
	t.Helper()
	zipBody, err := os.ReadFile(zipPath)
	if err != nil {
		t.Fatal(err)
	}
	gomod, err := os.ReadFile(filepath.Join("..", "..", "go.mod"))
	if err != nil {
		t.Fatal(err)
	}
	// The toolchain resolves `go install <package path>@latest` by asking
	// the proxy for the package path first and falling back to the module
	// root, so every request for either path is answered with this module's
	// files: the published proxy answers a package path the same way.
	infoJSON, err := json.Marshal(struct{ Version string }{Version: "v0.9.9"})
	if err != nil {
		t.Fatal(err)
	}
	// This proxy speaks only for the module root. A request for the package
	// path used as a module path answers 404, which is what makes the
	// toolchain fall back to the module root — the same way
	// proxy.golang.org behaves.
	const module = "/github.com/!nishfleet/drive"
	mux := http.NewServeMux()
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		rest := strings.TrimPrefix(r.URL.Path, module)
		switch rest {
		case "/@latest", "/@v/v0.9.9.info":
			w.Header().Set("content-type", "application/json")
			_, _ = w.Write(infoJSON)
		case "/@v/list":
			_, _ = w.Write([]byte("v0.9.9\n"))
		case "/@v/v0.9.9.mod":
			_, _ = w.Write(gomod)
		case "/@v/v0.9.9.zip":
			_, _ = w.Write(zipBody)
		default:
			http.NotFound(w, r)
		}
	})
	srv := httptest.NewServer(mux)
	return srv.URL, srv.Close
}

// updateTestDir is a temporary directory the test's own cleanup can delete.
// The Go module cache and build cache write their files read-only, so a
// plain t.TempDir() would fail to remove them; the chmod pass runs first
// (cleanups are last-in, first-out) and makes the removal possible.
func updateTestDir(t *testing.T) string {
	t.Helper()
	dir := t.TempDir()
	t.Cleanup(func() {
		_ = filepath.WalkDir(dir, func(p string, _ fs.DirEntry, err error) error {
			if err == nil {
				_ = os.Chmod(p, 0o700)
			}
			return nil
		})
	})
	return dir
}

// updateTestEnv is the environment a `go install` runs with in these tests:
// GOPATH, GOBIN, GOCACHE and GOPROXY pinned to the test so the install
// touches nothing outside it, and checksums off because the local proxy has
// no checksum database. The unnamed `go` on PATH is the toolchain CI installs.
func updateTestEnv(t *testing.T, proxyURL string) []string {
	t.Helper()
	gopath := updateTestDir(t)
	return append(os.Environ(),
		"GOPATH="+gopath,
		"GOBIN="+filepath.Join(gopath, "bin"),
		"GOCACHE="+updateTestDir(t),
		"GOPROXY="+proxyURL,
		"GOSUMDB=off",
		"GOTOOLCHAIN=local",
		"GOFLAGS=",
	)
}

// envValue reads one NAME=value out of an environment.
func envValue(t *testing.T, env []string, name string) string {
	t.Helper()
	for _, e := range env {
		if strings.HasPrefix(e, name+"=") {
			return strings.TrimPrefix(e, name+"=")
		}
	}
	t.Fatalf("%s not in the test environment", name)
	return ""
}

// A real `go install` against a local module proxy that serves a tagged
// version of this module: the released version is discovered, the binary is
// replaced, and the installed binary reports the new version both to this
// command and to `drive version` in its own process. This is the issue's
// finish line, run end to end.
func TestUpdateInstallsTheLatestRelease(t *testing.T) {
	if _, err := exec.LookPath("go"); err != nil {
		t.Skip("go not on PATH")
	}
	zipPath := makeProxyZip(t)
	proxyURL, cleanup := localProxy(t, zipPath)
	defer cleanup()
	env := updateTestEnv(t, proxyURL)
	out := new(strings.Builder)
	if err := updateDrive(updateOptions{
		proxyBase: proxyURL,
		goEnv:     env,
		dir:       t.TempDir(),
		out:       out,
		err:       os.Stderr,
	}); err != nil {
		t.Fatal(err)
	}
	if got := out.String(); !strings.Contains(got, "updated drive 0.1.0 -> v0.9.9") {
		t.Fatalf("update output = %q, want the old and new versions", got)
	}
	bin := filepath.Join(envValue(t, env, "GOBIN"), "drive")
	if _, err := os.Stat(bin); err != nil {
		t.Fatalf("the update did not install a binary at %s: %v", bin, err)
	}
	v, err := binaryVersionAt(bin)
	if err != nil {
		t.Fatal(err)
	}
	if v != "v0.9.9" {
		t.Fatalf("installed binary reports %q, want v0.9.9", v)
	}
	// The finish line's second half, from the binary's own process.
	cmd := exec.Command(bin, "version")
	cmd.Env = env
	raw, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("drive version: %v\n%s", err, raw)
	}
	if got := strings.TrimSpace(string(raw)); got != "v0.9.9" {
		t.Fatalf("drive version printed %q, want v0.9.9", got)
	}
}

// --check names the newer release and installs nothing.
func TestUpdateCheckOnly(t *testing.T) {
	zipPath := makeProxyZip(t)
	proxyURL, cleanup := localProxy(t, zipPath)
	defer cleanup()
	env := updateTestEnv(t, proxyURL)
	out := new(strings.Builder)
	if err := updateDrive(updateOptions{
		proxyBase: proxyURL,
		goEnv:     env,
		dir:       t.TempDir(),
		out:       out,
		checkOnly: true,
	}); err != nil {
		t.Fatal(err)
	}
	want := "a newer drive is available: v0.9.9 (this machine runs 0.1.0)"
	if got := out.String(); !strings.Contains(got, want) {
		t.Fatalf("--check output = %q, want %q", got, want)
	}
	if _, err := os.Stat(filepath.Join(envValue(t, env, "GOBIN"), "drive")); !os.IsNotExist(err) {
		t.Fatal("--check must not install a binary")
	}
}

// A caller that leaves the writers out of updateOptions gets the console,
// not a panic: the zero value is the production path, not a nil dereference.
// Only --check runs here, so nothing is installed while the defaults apply.
func TestUpdateDefaultsTheWriters(t *testing.T) {
	zipPath := makeProxyZip(t)
	proxyURL, cleanup := localProxy(t, zipPath)
	defer cleanup()
	if err := updateDrive(updateOptions{
		proxyBase: proxyURL,
		goEnv:     updateTestEnv(t, proxyURL),
		dir:       t.TempDir(),
		checkOnly: true,
	}); err != nil {
		t.Fatal(err)
	}
}

// A machine already on the released version installs nothing.
func TestUpdateAlreadyUpToDate(t *testing.T) {
	zipPath := makeProxyZip(t)
	proxyURL, cleanup := localProxy(t, zipPath)
	defer cleanup()
	env := updateTestEnv(t, proxyURL)
	out := new(strings.Builder)
	if err := updateDrive(updateOptions{
		proxyBase: proxyURL,
		goEnv:     env,
		dir:       t.TempDir(),
		out:       out,
		from:      "v0.9.9",
	}); err != nil {
		t.Fatal(err)
	}
	if got := out.String(); !strings.Contains(got, "drive is up to date (v0.9.9)") {
		t.Fatalf("up-to-date output = %q", got)
	}
	if _, err := os.Stat(filepath.Join(envValue(t, env, "GOBIN"), "drive")); !os.IsNotExist(err) {
		t.Fatal("an up-to-date machine must not install")
	}
}

// A proxy that refuses is a named error, never a silent "up to date".
func TestUpdateFailsOnProxyError(t *testing.T) {
	srv := httptest.NewServer(http.NotFoundHandler())
	defer srv.Close()
	err := updateDrive(updateOptions{proxyBase: srv.URL, out: io.Discard, err: io.Discard})
	if err == nil {
		t.Fatal("a proxy that answers 404 must be an error")
	}
	if !strings.Contains(err.Error(), srv.URL) {
		t.Fatalf("the error should name the proxy it could not read, got: %v", err)
	}
}

// No Go toolchain: the command says so and installs nothing.
func TestUpdateFailsWhenGoIsMissing(t *testing.T) {
	zipPath := makeProxyZip(t)
	proxyURL, cleanup := localProxy(t, zipPath)
	defer cleanup()
	env := updateTestEnv(t, proxyURL)
	// Two paths serve two purposes here: t.Setenv sets the PATH this
	// process's exec.LookPath reads, which is what resolveGo consults, and
	// env is the environment any child the install would start would get
	// (this test never reaches the install).
	t.Setenv("PATH", "/usr/bin:/bin")
	out := new(strings.Builder)
	err := updateDrive(updateOptions{
		proxyBase: proxyURL,
		goEnv:     env,
		dir:       t.TempDir(),
		out:       out,
		err:       io.Discard,
	})
	if err == nil {
		t.Fatal("no go toolchain must be an error")
	}
	if !strings.Contains(err.Error(), "go not found on PATH") {
		t.Fatalf("the error should name the missing toolchain, got: %v", err)
	}
	if strings.Contains(out.String(), "installing") {
		t.Fatal("a missing toolchain must not reach the install")
	}
}

// The proxy URL form is the module path's, not the file system's: uppercase
// letters are escaped as `!x`.
func TestModuleProxyPathEscapes(t *testing.T) {
	if got, want := moduleProxyPath("github.com/Nishfleet/drive"), "github.com/!nishfleet/drive"; got != want {
		t.Fatalf("moduleProxyPath = %q, want %q", got, want)
	}
}

// A binary built from a checkout, with the version-control stamping off, has
// no module version in it, so `drive version` falls back to the source-tree
// version.
func TestDriveVersionFallbackForACheckoutBuild(t *testing.T) {
	if _, err := exec.LookPath("go"); err != nil {
		t.Skip("go not on PATH")
	}
	bin := filepath.Join(t.TempDir(), "drive")
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
// pseudo-version, which is that binary's real identity — the update line then
// compares it against the released version and offers the release.
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
