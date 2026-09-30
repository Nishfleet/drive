package main

import (
	"fmt"
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

// LoadStorageConfig resolves the storage endpoint and keys from flags first,
// then environment variables, and fails loudly when a required value is
// missing. Endpoint, bucket and keys are config, not code: the same binary
// talks to the local stand-in or to iDrive e2.
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
		missing = append(missing, "secret key (--secret-key or DRIVE_S3_SECRET_ACCESS_KEY)")
	}
	if len(missing) > 0 {
		return c, fmt.Errorf("missing storage config: %s", strings.Join(missing, ", "))
	}
	return c, nil
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
	b.WriteString("[drive]\n")
	b.WriteString("type = s3\n")
	b.WriteString("provider = Other\n")
	fmt.Fprintf(&b, "access_key_id = %s\n", c.AccessKey)
	fmt.Fprintf(&b, "secret_access_key = %s\n", c.SecretKey)
	fmt.Fprintf(&b, "endpoint = %s\n", c.Endpoint)
	fmt.Fprintf(&b, "region = %s\n", c.Region)
	return b.String()
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
