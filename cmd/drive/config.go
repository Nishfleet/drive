package main

import (
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
)

// StorageConfig is the storage endpoint and keys, kept as config so switching
// to the real storage (iDrive e2, step 1) needs no code change. It is read
// from flags or environment variables; nothing here is provider-specific.
type StorageConfig struct {
	Endpoint  string // S3 endpoint URL, e.g. http://127.0.0.1:8080 (stand-in) or https://s3.eu-west-3.idrivee2-<n>.com
	AccessKey string
	SecretKey string
	Bucket    string
	Prefix    string // key prefix this device mounts, e.g. /u/<id>/
	Region    string // S3 region name; stand-ins accept any
}

// MountFlags are the stock rclone VFS flags this product mounts with. They are
// the same on Mac (nfsmount) and Linux (mount): the docs describe them.
const (
	VFSFlagCacheMode   = "--vfs-cache-mode full"
	VFSFlagWriteBack   = "--vfs-write-back 5s"
	VFSFlagCacheMax    = "--vfs-cache-max-size 20G"
	vfsCacheModeValue  = "full"
	vfsWriteBackValue  = "5s"
	vfsCacheMaxValue   = "20G"
	vfsChunkStreamSize = "32M" // streaming read-ahead for big files
)

// Default paths, overridable for tests.
func DefaultConfigDir(home string) string { return filepath.Join(home, ".config", "drive") }
func DefaultMountDir(home string) string  { return filepath.Join(home, "Drive") }
func DefaultCacheDir(home string) string  { return filepath.Join(home, ".cache", "drive", "vfs") }
func RcloneConfigPath(home string) string {
	return filepath.Join(DefaultConfigDir(home), "rclone.conf")
}
func LaunchdPlistPath(home string) string {
	return filepath.Join(home, "Library", "LaunchAgents", LaunchdLabel+".plist")
}
func SystemdUnitPath(home string) string {
	return filepath.Join(home, ".config", "systemd", "user", SystemdUnitName)
}
func RcloneBinOverride(home string) string {
	return filepath.Join(DefaultConfigDir(home), "rclone-bin")
}

const (
	// LaunchdLabel is the launchd login-item label on macOS.
	LaunchdLabel = "com.nishfleet.drive"
	// SystemdUnitName is the systemd user unit on Linux (step 3).
	SystemdUnitName = "drive-mount.service"
	// RcloneRemoteName is the remote name this product owns in the rclone config.
	RcloneRemoteName = "drive"
)

// secretEnvName is the environment variable that carries the storage secret.
// It is the one the mount has always read; a flag alongside it is what this
// issue removed, because a flag is in the shell history and in ps for every
// user on the machine for as long as the process lives.
const secretEnvName = "DRIVE_S3_SECRET_ACCESS_KEY"

// secretWays names every safe way to hand the storage secret to `drive mount`,
// in the order a caller should reach for them, with the config file this run
// would read. It is printed by the error that refuses the flag it replaced, so
// a person upgrading sees what to do instead of only what stopped working. The
// example is a redirect, never a printf of a variable: a shell that expands a
// secret variable into a command line puts the secret back in the argv this
// change exists to keep it out of.
func secretWays(configPath string) string {
	return fmt.Sprintf(`the storage secret is not accepted on the command line; put it in
  1. the config file %s (mode 0600)
  2. the environment: DRIVE_S3_SECRET_ACCESS_KEY
  3. --secret-key-stdin, from a redirect or a pipe, as in
     drive mount --secret-key-stdin < secret-file
     or  pass show drive/s3-secret | drive mount --secret-key-stdin
where the secret is never in the command line, the shell history or ps`, configPath)
}

// maxSecretBytes bounds what a pipe can hand over. A storage secret is one
// short line; this exists so `--secret-key-stdin` cannot be pointed at a disk
// image and read the whole thing into the process.
const maxSecretBytes = 64 << 10

// ReadSecretKey resolves the storage secret from the safe sources, in the
// order the caller asked for them, and only from those (issue #75). The three
// sources are a pipe, the environment, and the config file this CLI itself
// wrote, and there is no fourth: no flag, so the secret can never be read out
// of /proc/<pid>/cmdline or out of a shell history file, which is the finding
// this issue opened with.
//
// configPath is the config file to fall back to, and an absent file is not an
// error (there is no key on this machine yet). wantStdin says the caller piped
// a secret in, and a pipe that carries nothing is a mistake rather than a
// missing value: a silent empty secret would mount with no credential and fail
// later with a confusing 403.
func ReadSecretKey(configPath string, wantStdin bool, stdin io.Reader) (string, error) {
	if wantStdin {
		// One line, as the flag says. The trailing newline a shell echo or a
		// file adds is not part of the secret; anything after the first line is
		// a caller that piped the wrong thing, and is refused rather than
		// mounted as one long, broken key.
		raw, err := io.ReadAll(io.LimitReader(stdin, maxSecretBytes+1))
		if err != nil {
			return "", fmt.Errorf("read the storage secret from stdin: %w", err)
		}
		if len(raw) > maxSecretBytes {
			return "", fmt.Errorf("the storage secret on stdin is longer than %d bytes; --secret-key-stdin reads one line", maxSecretBytes)
		}
		line, rest, _ := strings.Cut(string(raw), "\n")
		if strings.TrimSpace(rest) != "" {
			return "", errors.New("stdin carried more than one line; --secret-key-stdin reads one line of the secret")
		}
		secret := strings.TrimRight(line, "\r")
		if strings.TrimSpace(secret) == "" {
			return "", errors.New("no storage secret on stdin: --secret-key-stdin reads one line from the pipe")
		}
		return secret, nil
	}
	if env := os.Getenv(secretEnvName); env != "" {
		return env, nil
	}
	if configPath == "" {
		return "", nil
	}
	if err := checkSecretFileMode(configPath); err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			return "", nil
		}
		return "", err
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

// checkSecretFileMode refuses a config file other users can read before the
// secret in it is read. A 0644 rclone.conf is the storage secret in every
// shell's reach on the machine, the same exposure as the flag this issue
// removed, so the error names the mode and the fix.
func checkSecretFileMode(path string) error {
	info, err := os.Stat(path)
	if err != nil {
		return err
	}
	if perm := info.Mode().Perm(); perm&0o077 != 0 {
		return fmt.Errorf("%s is mode %04o, so the storage secret in it is readable by "+
			"every user on this machine; chmod 600 %s", path, perm, path)
	}
	return nil
}

// ParseRcloneConfig reads the drive remote back out of the rclone config this
// CLI wrote. It is the same INI the tool uses (sections in brackets, `key =
// value`, comments with # or ;) and only the fields the drive owns are taken,
// so nothing in the file can be talked into handing over another remote's
// credentials. A config that names no key is an error, not an empty struct:
// logout must not call a half-read key this device's.
func ParseRcloneConfig(path string) (StorageConfig, error) {
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
		name, value, ok := strings.Cut(line, "=")
		if !ok {
			// The line itself is not quoted: a config whose line is malformed
			// can be a bare secret, and this error reaches the terminal.
			return StorageConfig{}, fmt.Errorf("%s line %d is not a key = value line", path, lineNo+1)
		}
		name = strings.ToLower(strings.TrimSpace(name))
		value = strings.TrimSpace(value)
		if section != RcloneRemoteName {
			continue
		}
		switch name {
		case "access_key_id":
			c.AccessKey = value
		case "secret_access_key":
			c.SecretKey = value
		case "endpoint":
			c.Endpoint = value
		case "region":
			c.Region = value
		}
	}
	if c.AccessKey == "" || c.SecretKey == "" {
		return StorageConfig{}, fmt.Errorf("%s: the [%s] remote carries no access key id and secret key", path, RcloneRemoteName)
	}
	return c, nil
}

// LoadStorageConfig resolves the storage endpoint and keys and fails loudly
// when a required value is missing. Flags win over the environment for every
// value except the storage secret, which has no flag at all (issue #75) and
// arrives already resolved from config.go `ReadSecretKey`. Endpoint, bucket
// and keys are config, not code: the same binary talks to the local stand-in
// or to iDrive e2.
func LoadStorageConfig(endpoint, bucket, prefix, region, accessKey, secretKey string) (StorageConfig, error) {
	c := StorageConfig{
		Endpoint:  firstNonEmpty(endpoint, os.Getenv("DRIVE_S3_ENDPOINT")),
		Bucket:    firstNonEmpty(bucket, os.Getenv("DRIVE_S3_BUCKET")),
		Prefix:    firstNonEmpty(prefix, os.Getenv("DRIVE_S3_PREFIX")),
		Region:    firstNonEmpty(region, os.Getenv("DRIVE_S3_REGION"), "us-east-1"),
		AccessKey: firstNonEmpty(accessKey, os.Getenv("DRIVE_S3_ACCESS_KEY_ID")),
		SecretKey: firstNonEmpty(secretKey, os.Getenv("DRIVE_S3_SECRET_ACCESS_KEY")),
	}
	var missing []string
	if c.Endpoint == "" {
		missing = append(missing, "endpoint (--endpoint or DRIVE_S3_ENDPOINT)")
	}
	if c.Bucket == "" {
		missing = append(missing, "bucket (--bucket or DRIVE_S3_BUCKET)")
	}
	if c.AccessKey == "" {
		missing = append(missing, "access key (--access-key or DRIVE_S3_ACCESS_KEY_ID)")
	}
	if c.SecretKey == "" {
		missing = append(missing, fmt.Sprintf("secret key (%s, --secret-key-stdin, or the config file)", secretEnvName))
	}
	if len(missing) > 0 {
		return c, fmt.Errorf("missing storage config: %s", strings.Join(missing, ", "))
	}
	// These values are written into the rclone config as INI values, one per
	// line. A newline or carriage return in any of them would end the line and
	// let a value smuggle in an extra rclone option (a different provider, a
	// no_check_certificate, its own endpoint). Refuse rather than escape, so a
	// rejected key is visible at the point it is set.
	for _, f := range []struct {
		name  string
		value string
	}{
		{"endpoint", c.Endpoint},
		{"bucket", c.Bucket},
		{"prefix", c.Prefix},
		{"region", c.Region},
		{"access key", c.AccessKey},
		{"secret key", c.SecretKey},
	} {
		if err := checkConfigValue(f.name, f.value); err != nil {
			return c, err
		}
	}
	return c, nil
}

// checkConfigValue rejects a value that would break out of its line in the
// generated rclone config.
func checkConfigValue(name, value string) error {
	if strings.ContainsAny(value, "\r\n") {
		return fmt.Errorf("invalid %s: a newline would inject an rclone option", name)
	}
	if strings.Contains(value, "\x00") {
		return fmt.Errorf("invalid %s: contains a NUL byte", name)
	}
	return nil
}

func firstNonEmpty(vals ...string) string {
	for _, v := range vals {
		if v != "" {
			return v
		}
	}
	return ""
}

// RcloneConfig renders the drive-managed rclone config file. The remote is an
// S3 backend pointed at this device's storage endpoint and key; s3v4 is the
// stock signature version every S3-compatible provider accepts.
func RcloneConfig(c StorageConfig) string {
	var b strings.Builder
	fmt.Fprintf(&b, "[%s]\n", RcloneRemoteName)
	b.WriteString("type = s3\n")
	b.WriteString("provider = Other\n")
	fmt.Fprintf(&b, "access_key_id = %s\n", c.AccessKey)
	fmt.Fprintf(&b, "secret_access_key = %s\n", c.SecretKey)
	fmt.Fprintf(&b, "endpoint = %s\n", c.Endpoint)
	fmt.Fprintf(&b, "region = %s\n", c.Region)
	return b.String()
}

// RcloneConfigRedacted renders the same config for display, with both keys
// replaced by a placeholder. `drive mount --dry-run` prints this, so a dry run
// on a shared screen or in a terminal transcript can never leak the device's
// secret key. The real config is still written 0600 by Mount.
func RcloneConfigRedacted(c StorageConfig) string {
	r := c
	r.AccessKey = "<redacted>"
	r.SecretKey = "<redacted>"
	return RcloneConfig(r)
}

// WriteFileAtomic writes data to path via a sibling temp file and rename, with
// 0600 for secret-bearing files.
func WriteFileAtomic(path string, data []byte, mode os.FileMode) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return fmt.Errorf("create dir for %s: %w", path, err)
	}
	tmp, err := os.CreateTemp(filepath.Dir(path), ".drive-*")
	if err != nil {
		return fmt.Errorf("temp file for %s: %w", path, err)
	}
	tmpName := tmp.Name()
	defer os.Remove(tmpName)
	if _, err := tmp.Write(data); err != nil {
		tmp.Close()
		return fmt.Errorf("write %s: %w", path, err)
	}
	if err := tmp.Close(); err != nil {
		return fmt.Errorf("close %s: %w", path, err)
	}
	if err := os.Chmod(tmpName, mode); err != nil {
		return fmt.Errorf("chmod %s: %w", path, err)
	}
	if err := os.Rename(tmpName, path); err != nil {
		return fmt.Errorf("rename into place %s: %w", path, err)
	}
	return nil
}
