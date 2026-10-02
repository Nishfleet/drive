package main

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

// StorageConfig is the storage endpoint and keys, kept as config so switching
// to the real storage (iDrive e2, step 1) needs no code change. Everything but
// the keys is read from flags, falling back to the environment; the keys are
// read from the environment only, because a command-line argument is visible
// in `ps` output and in the shell history for as long as the process lives, and
// a device key does not belong in either. Nothing here is provider-specific.
type StorageConfig struct {
	Endpoint  string // S3 endpoint URL, e.g. http://127.0.0.1:8080 (stand-in) or https://s3.eu-west-3.idrivee2-<n>.com
	AccessKey string
	SecretKey string
	Bucket    string
	Prefix    string // key prefix this device mounts, e.g. /u/<id>/
	Region    string // S3 region name; stand-ins accept any
	// DownloadURL is the dl Worker (drive issue #58, build step 5): the host
	// reads stream through, so the mount's reads land in that account's
	// download bytes. Empty means no download host is configured, and the
	// mount then reads straight from storage and counts nothing, which is the
	// honest state of a local stand-in.
	DownloadURL string
}

// vfsCacheModeValue, vfsWriteBackValue, vfsCacheMaxValue and
// vfsChunkStreamSize are the stock rclone VFS flags this product mounts with.
// They are the same on Mac (nfsmount) and Linux (mount), and mount.go VFSArgs
// is the one place that turns them into an argument vector.
const (
	vfsCacheModeValue    = "full"
	vfsWriteBackValue    = "5s"
	vfsCacheMaxValue     = "20G"
	vfsDirCacheTimeValue = "5s"  // see VFSArgs: S3 sends no change notifications
	vfsChunkStreamSize   = "32M" // streaming read-ahead for big files
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

const (
	// LaunchdLabel is the launchd login-item label on macOS.
	LaunchdLabel = "com.nishfleet.drive"
	// SystemdUnitName is the systemd user unit on Linux (step 3).
	SystemdUnitName = "drive-mount.service"
	// RcloneRemoteName is the remote name this product owns in the rclone config.
	RcloneRemoteName = "drive"
)

// LoadStorageConfig resolves the storage endpoint, bucket, prefix, region and
// the dl Worker's download URL from flags first, then environment variables,
// and the device keys from the environment alone
// (DRIVE_S3_ACCESS_KEY_ID and DRIVE_S3_SECRET_ACCESS_KEY).
// It fails loudly when a required value is missing. Endpoint, bucket and keys
// are config, not code: the same binary talks to the local stand-in or to
// iDrive e2. There is deliberately no flag for either key.
func LoadStorageConfig(endpoint, bucket, prefix, region, downloadURL string) (StorageConfig, error) {
	c := StorageConfig{
		Endpoint:  firstNonEmpty(endpoint, os.Getenv("DRIVE_S3_ENDPOINT")),
		Bucket:    firstNonEmpty(bucket, os.Getenv("DRIVE_S3_BUCKET")),
		Prefix:    firstNonEmpty(prefix, os.Getenv("DRIVE_S3_PREFIX")),
		Region:    firstNonEmpty(region, os.Getenv("DRIVE_S3_REGION"), "us-east-1"),
		AccessKey: os.Getenv("DRIVE_S3_ACCESS_KEY_ID"),
		SecretKey: os.Getenv("DRIVE_S3_SECRET_ACCESS_KEY"),
		// The download host is optional and has no default: with none set the
		// mount reads straight from storage (the local stand-in case), and with
		// one set rclone streams every read through the dl Worker, which counts
		// the bytes into that account's download total (docs/build-spec.md
		// "The pieces", items 2 and 4).
		DownloadURL: firstNonEmpty(downloadURL, os.Getenv("DRIVE_DOWNLOAD_URL")),
	}
	var missing []string
	if c.Endpoint == "" {
		missing = append(missing, "endpoint (--endpoint or DRIVE_S3_ENDPOINT)")
	}
	if c.Bucket == "" {
		missing = append(missing, "bucket (--bucket or DRIVE_S3_BUCKET)")
	}
	if c.AccessKey == "" {
		missing = append(missing, "access key (DRIVE_S3_ACCESS_KEY_ID)")
	}
	if c.SecretKey == "" {
		missing = append(missing, "secret key (DRIVE_S3_SECRET_ACCESS_KEY)")
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
		{"download url", c.DownloadURL},
		{"access key", c.AccessKey},
		{"secret key", c.SecretKey},
	} {
		if err := checkConfigValue(f.name, f.value); err != nil {
			return c, err
		}
	}
	// The prefix is the device's own folder inside the bucket. A `..` segment in
	// it would mount a parent's contents, so one device's mount could read or
	// write another device's prefix; nothing legitimate needs to walk up, so it
	// is refused here rather than normalized away.
	if err := checkPrefix(c.Prefix); err != nil {
		return c, err
	}
	return c, nil
}

// checkPrefix refuses a key prefix that walks out of the device's own folder.
func checkPrefix(prefix string) error {
	trimmed := strings.Trim(prefix, "/")
	if trimmed == "" {
		return nil
	}
	for _, seg := range strings.Split(trimmed, "/") {
		if seg == ".." {
			return fmt.Errorf("invalid prefix: %q walks out of this device's folder", prefix)
		}
	}
	return nil
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
