package main

import (
	"encoding/xml"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"testing"
)

// TestAgentPathStandinRefusesDeleteCapAndRevoke is drive#514 finish-line 2:
// a delete through the agent credential is refused by storage, a cap-exceeded
// agent cannot write, and a revoked agent cannot read. The stand-in is a local
// S3 server the test owns, because the loopback `rclone serve s3` does not
// enforce per-key capabilities.
func TestAgentPathStandinRefusesDeleteCapAndRevoke(t *testing.T) {
	if _, err := exec.LookPath("rclone"); err != nil {
		t.Skip("rclone is not installed")
	}
	store := newAgentStandin()
	server := httptest.NewServer(store)
	t.Cleanup(server.Close)

	home := t.TempDir()
	root := t.TempDir()
	agent := StorageConfig{
		Endpoint:  server.URL,
		AccessKey: "AKIACLAUDE",
		SecretKey: "agent-secret",
		Bucket:    "bucket",
		Prefix:    "u/acct",
		Region:    "us-east-1",
	}
	overCap := agent
	overCap.AccessKey = "AKIACAP"
	overCap.SecretKey = "cap-secret"
	revoked := agent
	revoked.AccessKey = "AKIAREVOKED"
	revoked.SecretKey = "revoked-secret"
	store.allow("AKIACLAUDE", true, true, false)
	store.allow("AKIACAP", true, false, false)
	store.allow("AKIAREVOKED", false, false, false)
	store.put("u/acct/note.txt", []byte("hello"))

	if err := rcloneTo(t, home, "seed", agent, root, "note.txt", []byte("hello")); err != nil {
		t.Fatalf("seed write with the agent key: %v", err)
	}

	if err := rcloneOp(t, home, "delete", agent, "deletefile", RemoteFor(agent)+"/note.txt"); err == nil {
		t.Fatal("a delete through the agent path must be refused by storage")
	} else if !standinRefused(err) {
		t.Fatalf("agent delete error was not a storage refusal: %v", err)
	}

	if err := rcloneTo(t, home, "cap", overCap, root, "cap.txt", []byte("no")); err == nil {
		t.Fatal("a cap-exceeded agent must not write")
	} else if !standinRefused(err) {
		t.Fatalf("cap-exceeded write error was not a storage refusal: %v", err)
	}

	if err := rcloneOp(t, home, "revoked", revoked, "cat", RemoteFor(revoked)+"/note.txt"); err == nil {
		t.Fatal("a revoked agent must not read")
	} else if !standinRefused(err) {
		t.Fatalf("revoked read error was not a storage refusal: %v", err)
	}
}

func standinRefused(err error) bool {
	s := err.Error()
	return strings.Contains(s, "AccessDenied") || strings.Contains(s, "403")
}

func rcloneTo(t *testing.T, home, name string, cfg StorageConfig, root, file string, body []byte) error {
	t.Helper()
	local := filepath.Join(root, name, file)
	if err := os.MkdirAll(filepath.Dir(local), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(local, body, 0o600); err != nil {
		t.Fatal(err)
	}
	return rcloneOp(t, home, name, cfg, "copyto", local, RemoteFor(cfg)+"/"+file)
}

func rcloneOp(t *testing.T, home, name string, cfg StorageConfig, args ...string) error {
	t.Helper()
	cfgDir := filepath.Join(home, name)
	if err := os.MkdirAll(cfgDir, 0o700); err != nil {
		t.Fatal(err)
	}
	conf := filepath.Join(cfgDir, "rclone.conf")
	if err := WriteFileAtomic(conf, []byte(RcloneConfig(cfg)), 0o600); err != nil {
		t.Fatal(err)
	}
	cmd := exec.Command("rclone", args...)
	cmd.Env = append(os.Environ(),
		"RCLONE_CONFIG="+conf,
		rcloneSecretEnv+"="+cfg.SecretKey,
	)
	out, err := cmd.CombinedOutput()
	if err != nil {
		return &standinOpError{out: string(out), err: err}
	}
	return nil
}

type standinOpError struct {
	out string
	err error
}

func (e *standinOpError) Error() string { return e.err.Error() + "\n" + e.out }

type agentStandin struct {
	mu    sync.Mutex
	files map[string][]byte
	caps  map[string]standinCaps
}

type standinCaps struct {
	read, write, delete bool
}

func newAgentStandin() *agentStandin {
	return &agentStandin{
		files: map[string][]byte{},
		caps:  map[string]standinCaps{},
	}
}

func (s *agentStandin) allow(accessKey string, read, write, delete bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.caps[accessKey] = standinCaps{read: read, write: write, delete: delete}
}

func (s *agentStandin) put(key string, body []byte) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.files[key] = body
}

func (s *agentStandin) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	keyID := accessKeyFromAuth(r.Header.Get("Authorization"))
	s.mu.Lock()
	caps, known := s.caps[keyID]
	s.mu.Unlock()
	if !known {
		s3Denied(w)
		return
	}
	object := strings.TrimPrefix(r.URL.Path, "/bucket/")
	if object == r.URL.Path {
		object = strings.TrimPrefix(r.URL.Path, "/bucket")
		object = strings.TrimPrefix(object, "/")
	}
	switch {
	case r.Method == http.MethodPut && object != "":
		if !caps.write {
			s3Denied(w)
			return
		}
		body, _ := io.ReadAll(r.Body)
		s.mu.Lock()
		s.files[object] = body
		s.mu.Unlock()
		w.WriteHeader(http.StatusOK)
	case (r.Method == http.MethodGet || r.Method == http.MethodHead) && object != "" && r.URL.RawQuery == "":
		if !caps.read {
			s3Denied(w)
			return
		}
		s.mu.Lock()
		body, ok := s.files[object]
		s.mu.Unlock()
		if !ok {
			http.NotFound(w, r)
			return
		}
		w.Header().Set("Content-Length", strconv.Itoa(len(body)))
		w.Header().Set("ETag", `"standin"`)
		if r.Method == http.MethodGet {
			_, _ = w.Write(body)
		}
	case r.Method == http.MethodDelete:
		if !caps.delete {
			s3Denied(w)
			return
		}
		s.mu.Lock()
		delete(s.files, object)
		s.mu.Unlock()
		w.WriteHeader(http.StatusNoContent)
	default:
		if !caps.read {
			s3Denied(w)
			return
		}
		s.mu.Lock()
		type content struct {
			XMLName      xml.Name `xml:"Contents"`
			Key          string   `xml:"Key"`
			Size         int      `xml:"Size"`
			ETag         string   `xml:"ETag"`
			LastModified string   `xml:"LastModified"`
		}
		var contents []content
		prefix := r.URL.Query().Get("prefix")
		for k, body := range s.files {
			if prefix != "" && !strings.HasPrefix(k, prefix) {
				continue
			}
			contents = append(contents, content{
				Key: k, Size: len(body), ETag: `"standin"`,
				LastModified: "2026-01-01T00:00:00.000Z",
			})
		}
		s.mu.Unlock()
		w.Header().Set("Content-Type", "application/xml")
		_ = xml.NewEncoder(w).Encode(struct {
			XMLName  xml.Name  `xml:"ListBucketResult"`
			Name     string    `xml:"Name"`
			Prefix   string    `xml:"Prefix"`
			KeyCount int       `xml:"KeyCount"`
			Contents []content `xml:"Contents"`
		}{Name: "bucket", Prefix: prefix, KeyCount: len(contents), Contents: contents})
	}
}

func accessKeyFromAuth(h string) string {
	_, rest, ok := strings.Cut(h, "Credential=")
	if !ok {
		return ""
	}
	id, _, _ := strings.Cut(rest, "/")
	return id
}

func s3Denied(w http.ResponseWriter) {
	w.Header().Set("Content-Type", "application/xml")
	w.WriteHeader(http.StatusForbidden)
	_, _ = w.Write([]byte(`<?xml version="1.0"?><Error><Code>AccessDenied</Code><Message>Access Denied</Message></Error>`))
}
