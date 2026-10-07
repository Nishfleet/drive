package main

import (
	"context"
	"net/http"
	"strings"
	"sync"
	"testing"
)

func TestMountRCClientReadsTheStoredAddressAndChecksVersion(t *testing.T) {
	var mu sync.Mutex
	var paths []string
	c := fakeRclone(t, func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		paths = append(paths, r.URL.Path)
		mu.Unlock()
		if strings.Contains(r.URL.Path, "core/version") {
			_, _ = w.Write([]byte(rcloneVersionJSON))
			return
		}
		_, _ = w.Write([]byte(`{"rate":"off"}`))
	})
	home := t.TempDir()
	cfg := testStorage()
	if err := WriteRcloneEnv(home, cfg, "rcuserhex", "rcpasshex", c.addr); err != nil {
		t.Fatal(err)
	}
	t.Setenv("DRIVE_RCLONE", c.binary)
	t.Setenv("DRIVE_RC_ADDR", "")
	got, err := mountRCClient(home)
	if err != nil {
		t.Fatalf("mountRCClient: %v", err)
	}
	if got.addr != c.addr {
		t.Errorf("client addr = %q, want the stored %q", got.addr, c.addr)
	}
	mu.Lock()
	defer mu.Unlock()
	if len(paths) != 1 || paths[0] != "/core/version" {
		t.Errorf("first rc call = %v, want /core/version only", paths)
	}
}

func TestMountRCClientRefusesAnEmptyVersion(t *testing.T) {
	c := fakeRclone(t, func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(`{"version":""}`))
	})
	home := t.TempDir()
	t.Setenv("DRIVE_RCLONE", c.binary)
	t.Setenv("DRIVE_RC_ADDR", c.addr)
	_, err := mountRCClient(home)
	if err == nil {
		t.Fatal("mountRCClient accepted an empty core/version, want a named failure")
	}
	if !strings.Contains(err.Error(), "core/version") {
		t.Errorf("error = %v, want core/version named", err)
	}
}

func TestMountRCClientRefusesAStrangerOnThePort(t *testing.T) {
	c := fakeRclone(t, func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(`{"ok":true}`))
	})
	home := t.TempDir()
	t.Setenv("DRIVE_RCLONE", c.binary)
	t.Setenv("DRIVE_RC_ADDR", c.addr)
	_, err := mountRCClient(home)
	if err == nil {
		t.Fatal("mountRCClient accepted a listener that is not rclone, want a named failure")
	}
}

func TestPickRCAddrHonorsTheOverride(t *testing.T) {
	t.Setenv("DRIVE_RC_ADDR", "127.0.0.1:5599")
	got, err := pickRCAddr()
	if err != nil {
		t.Fatal(err)
	}
	if got != "127.0.0.1:5599" {
		t.Errorf("pickRCAddr = %q, want the overridden address", got)
	}
}

func TestPickRCAddrDoesNotReuseTheShippedPort(t *testing.T) {
	t.Setenv("DRIVE_RC_ADDR", "")
	a, err := pickRCAddr()
	if err != nil {
		t.Fatal(err)
	}
	b, err := pickRCAddr()
	if err != nil {
		t.Fatal(err)
	}
	if a == loopbackRCAddr || b == loopbackRCAddr {
		t.Fatalf("pickRCAddr reused the shipped address %s (%q, %q)", loopbackRCAddr, a, b)
	}
	if a == b {
		t.Fatalf("two picks both returned %s", a)
	}
	if !IsLoopbackAddr(a) || !IsLoopbackAddr(b) {
		t.Fatalf("picks %q and %q must be loopback", a, b)
	}
}

func TestPrepareMountAuthStoresTheOverriddenRCAddr(t *testing.T) {
	t.Setenv("DRIVE_RC_ADDR", "127.0.0.1:5599")
	home := t.TempDir()
	cfg := testStorage()
	p := BuildMountPlan("linux", home, "rclone", cfg)
	if err := prepareMountAuth(home, &p, cfg); err != nil {
		t.Fatal(err)
	}
	if p.RCAddr != "127.0.0.1:5599" {
		t.Errorf("prepared RCAddr = %q, want the override", p.RCAddr)
	}
	auth, err := ReadRCAuth(home)
	if err != nil {
		t.Fatal(err)
	}
	if auth.Addr != "127.0.0.1:5599" {
		t.Errorf("stored addr = %q, want the override", auth.Addr)
	}
}

func TestResolveMountRCAddrDoesNotFallBackTo5572(t *testing.T) {
	home := t.TempDir()
	t.Setenv("DRIVE_RC_ADDR", "")
	_, err := resolveMountRCAddr(home)
	if err == nil {
		t.Fatal("resolveMountRCAddr used 5572 with no stored address")
	}
	if !strings.Contains(err.Error(), "missing") {
		t.Errorf("error = %v, want missing stored address", err)
	}
}

// vfs/refresh takes one folder per key: dir, dir2, dir3, ... rclone documents
// this ("Any parameter key starting with dir will refresh that directory",
// vfs/rc.go), so a kept-offline folder nested in another folder is one request,
// not a second rc call. This runs the real rcClient.call through the rclone
// shim and reads the form the shim forwarded, so the keys are checked on the
// wire rather than in a fake (issue #541).
func TestRefreshDirsAsksForEveryFolderInOneRequest(t *testing.T) {
	var mu sync.Mutex
	var sent map[string]string
	c := fakeRclone(t, func(w http.ResponseWriter, r *http.Request) {
		_ = r.ParseForm()
		mu.Lock()
		sent = map[string]string{}
		for k, v := range r.Form {
			if strings.HasPrefix(k, "dir") && len(v) > 0 {
				sent[k] = v[0]
			}
		}
		mu.Unlock()
		_, _ = w.Write([]byte(`{"result":{"photos":"OK","photos/2026":"OK"}}`))
	})
	if err := c.refreshDirs(context.Background(), []string{"photos", "photos/2026"}); err != nil {
		t.Fatalf("refreshDirs: %v", err)
	}
	mu.Lock()
	defer mu.Unlock()
	want := map[string]string{"dir": "photos", "dir2": "photos/2026"}
	if len(sent) != len(want) {
		t.Fatalf("refreshDirs sent %v, want %v", sent, want)
	}
	for k, v := range want {
		if sent[k] != v {
			t.Errorf("refreshDirs %s = %q, want %q", k, sent[k], v)
		}
	}
}

// The second folder's failure must reach the caller: vfs/refresh runs the
// folder it can and reports the one it cannot, and a swallowed error would
// leave a kept-offline folder reading a listing older than it thinks
// (issue #541).
func TestRefreshDirsSurfacesTheSecondFoldersFailure(t *testing.T) {
	c := fakeRclone(t, func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(`{"result":{"photos":"OK","photos/2026":"connection refused"}}`))
	})
	err := c.refreshDirs(context.Background(), []string{"photos", "photos/2026"})
	if err == nil || !strings.Contains(err.Error(), "connection refused") {
		t.Fatalf("refreshDirs = %v, want the second folder's failure named", err)
	}
}
