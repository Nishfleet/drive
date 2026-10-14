package login

import (
	"bufio"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"runtime"
	"strings"

	"github.com/Nishfleet/drive/internal/atomicwrite"
)

// StorageConfig is the storage endpoint and keys, kept as config so switching to the real storage (iDrive e2, step 1) needs no code change.
type StorageConfig struct {
	Endpoint     string
	AccessKey    string
	SecretKey    string
	SessionToken string
	Bucket       string
	Prefix       string
	Region       string
	DownloadURL  string
}

// Default paths, overridable for tests.
func DefaultConfigDir(home string) string { return filepath.Join(home, ".config", "drive") }
func DefaultMountDir(home string) string  { return filepath.Join(home, "Drive") }
func DefaultCacheDir(home string) string  { return filepath.Join(home, ".cache", "drive", "vfs") }
func RcloneConfigPath(home string) string {
	return filepath.Join(DefaultConfigDir(home), "rclone.conf")
}

// RcloneEnvPath is the 0600 EnvironmentFile the mount writes for rclone: the remote-control user/password and the storage secret as rclone's own RCLONE_CONFIG_<REMOTE>_* variables.
func RcloneEnvPath(home string) string {
	return filepath.Join(DefaultConfigDir(home), "rclone.env")
}

const (
	// RcloneRemoteName is the remote name this product owns in the rclone config.
	RcloneRemoteName = "drive"
)

// SecretEnvName is the environment variable that carries the storage secret.
const SecretEnvName = "DRIVE_S3_SECRET_ACCESS_KEY"

// rclone's own environment names for the mount process (rclone.org/docs "Environment Variables"): --rc-user/--rc-pass become RCLONE_RC_USER / RCLONE_RC_PASS, and a config key on the drive remote becomes RCLONE_CONFIG_DRIVE_<KEY>.
const (
	RCUserEnv = "RCLONE_RC_USER"
	RCPassEnv = "RCLONE_RC_PASS"
	SecretEnv = "RCLONE_CONFIG_DRIVE_SECRET_ACCESS_KEY"
	// RCAddrEnv is the environment variable that carries the remote control's loopback address.
	RCAddrEnv = "DRIVE_RC_ADDR"
	// DownloadURLEnv is the S3 backend's download_url (the dl Worker).
	DownloadURLEnv = "RCLONE_CONFIG_DRIVE_DOWNLOAD_URL"
)

// MaxSecretBytes bounds what a pipe can hand over.
const MaxSecretBytes = 64 << 10

// ReadSecretKey resolves the storage secret from the safe sources and only from those (issue #75, drive#498).
func ReadSecretKey(configPath string, wantStdin bool, stdin io.Reader) (string, error) {
	if wantStdin {
		reader := bufio.NewReaderSize(stdin, MaxSecretBytes+1)
		line, err := reader.ReadSlice('\n')
		switch {
		case err == nil || errors.Is(err, io.EOF):
		case errors.Is(err, bufio.ErrBufferFull):
			return "", fmt.Errorf("the storage secret on stdin is longer than %d bytes; --secret-key-stdin reads one line", MaxSecretBytes)
		default:
			return "", fmt.Errorf("read the storage secret from stdin: %w", err)
		}
		if len(line) > MaxSecretBytes {
			return "", fmt.Errorf("the storage secret on stdin is longer than %d bytes; --secret-key-stdin reads one line", MaxSecretBytes)
		}
		secret := strings.TrimSpace(string(line))
		if secret == "" {
			return "", errors.New("no storage secret on stdin: --secret-key-stdin reads one line from the pipe")
		}
		if extra := reader.Buffered(); extra > 0 {
			rest, err := io.ReadAll(io.LimitReader(reader, int64(extra)))
			if err != nil {
				return "", fmt.Errorf("read the storage secret from stdin: %w", err)
			}
			if strings.TrimSpace(string(rest)) != "" {
				return "", errors.New("stdin carried more than one line; --secret-key-stdin reads one line of the secret")
			}
		}
		return secret, nil
	}
	if env := os.Getenv(SecretEnvName); env != "" {
		return env, nil
	}
	if configPath == "" {
		return "", nil
	}
	if secret, err := SecretFromEnvFile(EnvPathBeside(configPath)); err != nil {
		return "", err
	} else if secret != "" {
		return secret, nil
	}
	c, err := ParseRcloneConfig(configPath)
	if err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			return "", nil
		}
		return "", err
	}
	return c.SecretKey, nil
}

// checkSecretFileMode refuses a config file other users can read before the secret in it is read.
func CheckSecretFileMode(path string) error {
	info, err := os.Stat(path)
	if err != nil {
		return err
	}
	if !info.Mode().IsRegular() {
		return fmt.Errorf("%s is not a regular file (mode %s), so it is not the drive config", path, info.Mode())
	}
	// On Windows FileMode.Perm() reports 0666/0444 for every file; mode bits are a POSIX concept.
	if runtime.GOOS == "windows" {
		return nil
	}
	if perm := info.Mode().Perm(); perm&0o077 != 0 {
		return fmt.Errorf("%s is mode %04o, so the storage secret in it is readable by "+
			"every user on this machine; chmod 600 %s", path, perm, path)
	}
	return nil
}

// ParseRcloneConfig reads the drive remote back out of the rclone config this CLI wrote.
func ParseRcloneConfig(path string) (StorageConfig, error) {
	if err := CheckSecretFileMode(path); err != nil {
		return StorageConfig{}, err
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		return StorageConfig{}, err
	}
	c := StorageConfig{}
	section := ""
	for lineNo, line := range strings.Split(string(raw), "\n") {
		line = strings.TrimSpace(line)
		if line == "" || strings.HasPrefix(line, "#") || strings.HasPrefix(line, ";") {
			continue
		}
		if strings.HasPrefix(line, "[") && strings.HasSuffix(line, "]") {
			section = strings.TrimSpace(line[1 : len(line)-1])
			continue
		}
		if section != RcloneRemoteName {
			continue
		}
		name, value, ok := strings.Cut(line, "=")
		if !ok {
			return StorageConfig{}, fmt.Errorf("%s line %d is not a key = value line", path, lineNo+1)
		}
		name = strings.ToLower(strings.TrimSpace(name))
		value = strings.TrimSpace(value)
		switch name {
		case "access_key_id":
			c.AccessKey = value
		case "secret_access_key":
			c.SecretKey = value
		case "session_token":
			c.SessionToken = value
		case "endpoint":
			c.Endpoint = value
		case "region":
			c.Region = value
		}
	}
	if c.AccessKey == "" && c.SecretKey == "" {
		return StorageConfig{}, fmt.Errorf("%s: the [%s] remote carries no access key id or secret key", path, RcloneRemoteName)
	}
	return c, nil
}

// RcloneConfig renders the drive-managed rclone config file.
func RcloneConfig(c StorageConfig) string {
	var b strings.Builder
	fmt.Fprintf(&b, "[%s]\n", RcloneRemoteName)
	b.WriteString("type = s3\n")
	b.WriteString("provider = Other\n")
	fmt.Fprintf(&b, "access_key_id = %s\n", c.AccessKey)
	if c.SessionToken != "" {
		fmt.Fprintf(&b, "session_token = %s\n", c.SessionToken)
		fmt.Fprintf(&b, "no_check_bucket = true\n")
	}
	fmt.Fprintf(&b, "endpoint = %s\n", c.Endpoint)
	fmt.Fprintf(&b, "region = %s\n", c.Region)
	return b.String()
}

// RcloneConfigRedacted renders the same config for display, with the access key replaced by a placeholder.
func RcloneConfigRedacted(c StorageConfig) string {
	r := c
	r.AccessKey = "<redacted>"
	r.SecretKey = ""
	if r.SessionToken != "" {
		r.SessionToken = "<redacted>"
	}
	return RcloneConfig(r)
}

// EnvPathBeside is rclone.env next to the rclone.conf path ReadSecretKey already holds, so the two files stay a pair without a second home argument.
func EnvPathBeside(configPath string) string {
	if configPath == "" {
		return ""
	}
	return filepath.Join(filepath.Dir(configPath), "rclone.env")
}

// RCAuth is the random user and password the mount generates for rclone's remote control, and the loopback address that mount bound.
type RCAuth struct {
	User string
	Pass string
	Addr string
}

// WriteRcloneEnv writes the 0600 EnvironmentFile rclone and systemd read: the remote-control user/password (hex, so they need no quoting), the loopback address that mount bound (drive#807), and the storage secret as rclone's own RCLONE_CONFIG_DRIVE_SECRET_ACCESS_KEY.
func WriteRcloneEnv(home string, c StorageConfig, rcUser, rcPass, rcAddr string) error {
	var b strings.Builder
	if rcUser != "" {
		fmt.Fprintf(&b, "%s=%s\n", RCUserEnv, rcUser)
		fmt.Fprintf(&b, "%s=%s\n", RCPassEnv, rcPass)
	}
	if rcAddr != "" {
		fmt.Fprintf(&b, "%s=%s\n", RCAddrEnv, rcAddr)
	}
	if c.SecretKey != "" {
		fmt.Fprintf(&b, "%s=%s\n", SecretEnv, EnvQuote(c.SecretKey))
	}
	if c.DownloadURL != "" {
		fmt.Fprintf(&b, "%s=%s\n", DownloadURLEnv, EnvQuote(c.DownloadURL))
	}
	if b.Len() == 0 {
		return nil
	}
	return atomicwrite.Write(RcloneEnvPath(home), []byte(b.String()), 0o600)
}

// ReadRCAuth reads the remote-control user, password and bound address from rclone.env.
func ReadRCAuth(home string) (RCAuth, error) {
	vals, err := parseRcloneEnvFile(RcloneEnvPath(home))
	if err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			return RCAuth{}, nil
		}
		return RCAuth{}, err
	}
	return RCAuth{User: vals[RCUserEnv], Pass: vals[RCPassEnv], Addr: vals[RCAddrEnv]}, nil
}

func SecretFromEnvFile(path string) (string, error) {
	if path == "" {
		return "", nil
	}
	vals, err := parseRcloneEnvFile(path)
	if err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			return "", nil
		}
		return "", err
	}
	return vals[SecretEnv], nil
}

func parseRcloneEnvFile(path string) (map[string]string, error) {
	if err := CheckSecretFileMode(path); err != nil {
		return nil, err
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	out := map[string]string{}
	for _, line := range strings.Split(string(raw), "\n") {
		line = strings.TrimSpace(line)
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		name, value, ok := strings.Cut(line, "=")
		if !ok {
			return nil, fmt.Errorf("%s: not a KEY=VALUE line", path)
		}
		out[strings.TrimSpace(name)] = unquoteEnvValue(strings.TrimSpace(value))
	}
	return out, nil
}

// EnvQuote quotes a value for systemd's EnvironmentFile and for this CLI's own parser: double quotes, with \, ", $ and ` escaped, so a storage secret cannot break out of its line.
func EnvQuote(v string) string {
	var b strings.Builder
	b.WriteByte('"')
	for _, r := range v {
		switch r {
		case '\\', '"', '$', '`':
			b.WriteByte('\\')
		}
		b.WriteRune(r)
	}
	b.WriteByte('"')
	return b.String()
}

func unquoteEnvValue(v string) string {
	if len(v) < 2 || v[0] != '"' || v[len(v)-1] != '"' {
		return v
	}
	var b strings.Builder
	escaped := false
	for _, r := range v[1 : len(v)-1] {
		if escaped {
			b.WriteRune(r)
			escaped = false
			continue
		}
		if r == '\\' {
			escaped = true
			continue
		}
		b.WriteRune(r)
	}
	if escaped {
		b.WriteByte('\\')
	}
	return b.String()
}
