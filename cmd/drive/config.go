package main

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

const (
	vfsCacheModeValue        = "full"
	vfsWriteBackValue        = "5s"
	vfsCacheMaxValue         = "20G"
	vfsDirCacheTimeValue     = "24h"
	vfsChunkStreamSize       = "32M"
	vfsReadAheadValue        = "128k"
	vfsReadChunkSizeValue    = "32M"
	vfsReadChunkStreamsValue = "2"
	vfsTransfersValue        = "4"

	vfsCacheMinFreeSpaceValue = "1G"
)

// CacheMaxPath is where the limit the person chose for the mount's cache lives.
func CacheMaxPath(home string) string {
	return filepath.Join(DefaultConfigDir(home), "cache-max")
}

// ResolveCacheMax is the limit the mount must run with: whatever the person set with `drive cache --max`, or the shipped vfsCacheMaxValue default.
func ResolveCacheMax(home string) (string, error) {
	data, err := os.ReadFile(CacheMaxPath(home))
	if err != nil {
		if os.IsNotExist(err) {
			return vfsCacheMaxValue, nil
		}
		return "", fmt.Errorf("read %s: %w", CacheMaxPath(home), err)
	}
	chosen := strings.TrimSpace(string(data))
	if chosen == "" {
		return vfsCacheMaxValue, nil
	}
	if _, err := parseSizeSuffix(chosen); err != nil {
		return "", fmt.Errorf("%s holds %q: a cache limit is a size like 5G or 500M, so this one is ignored until it is fixed", CacheMaxPath(home), chosen)
	}
	return chosen, nil
}

// SaveCacheMax validates the typed limit with rclone's own SizeSuffix parser and writes it for the next mount.
func SaveCacheMax(home, size string) error {
	bytes, err := parseSizeSuffix(size)
	if err != nil {
		return fmt.Errorf("the cache limit %q is not a size rclone reads: %w", size, err)
	}
	if bytes <= 0 {
		return fmt.Errorf("the cache limit %q is not more than nothing; 20G is the shipped default", size)
	}
	return WriteFileAtomic(CacheMaxPath(home), []byte(size+"\n"), 0o600)
}

var userHomeDir = os.UserHomeDir

// DefaultHome is the home directory every default path hangs off.
func DefaultHome() string {
	home, err := userHomeDir()
	if err != nil {
		return ""
	}
	return home
}

func LaunchdPlistPath(home string) string {
	return filepath.Join(home, "Library", "LaunchAgents", LaunchdLabel+".plist")
}
func SystemdUnitPath(home string) string {
	return filepath.Join(home, ".config", "systemd", "user", SystemdUnitName)
}
func PrefetchLaunchdPlistPath(home string) string {
	return filepath.Join(home, "Library", "LaunchAgents", PrefetchLaunchdLabel+".plist")
}
func PrefetchSystemdUnitPath(home string) string {
	return filepath.Join(home, ".config", "systemd", "user", PrefetchSystemdUnitName)
}

const (
	// LaunchdLabel is the launchd login-item label on macOS.
	LaunchdLabel = "com.nishfleet.drive"
	// PrefetchLaunchdLabel is the second login item that warms the next folder after a listing (issue #227).
	PrefetchLaunchdLabel = "com.nishfleet.drive.prefetch"
	// SystemdUnitName is the systemd user unit on Linux (step 3).
	SystemdUnitName = "drive-mount.service"
	// PrefetchSystemdUnitName is the sidecar that runs `drive prefetch`.
	PrefetchSystemdUnitName = "drive-prefetch.service"
)

func secretWays(configPath string) string {
	return fmt.Sprintf(`the storage secret is not accepted on the command line; put it in
  1. the 0600 env file %s
  2. the environment: DRIVE_S3_SECRET_ACCESS_KEY
  3. --secret-key-stdin, from a redirect or a pipe, as in
     drive mount --secret-key-stdin < secret-file
     or  pass show drive/s3-secret | drive mount --secret-key-stdin
where the secret is never in the command line, the shell history or ps`, rcloneEnvPathBeside(configPath))
}

func storageFromDisk(home string) StorageConfig {
	var c StorageConfig
	if creds, err := LoadCredentials(home); err == nil {
		c.Endpoint = creds.Endpoint
		c.Bucket = creds.Bucket
		c.Prefix = creds.Prefix
		c.Region = creds.Region
		c.DownloadURL = creds.DownloadURL
		c.AccessKey = creds.AccessKeyID
	}
	parsed, err := ParseRcloneConfig(RcloneConfigPath(home))
	if err != nil {
		if secret, envErr := secretFromEnvFile(RcloneEnvPath(home)); envErr == nil && secret != "" {
			c.SecretKey = secret
		}
		return c
	}
	c.AccessKey = firstNonEmpty(c.AccessKey, parsed.AccessKey)
	c.SecretKey = parsed.SecretKey
	if c.SecretKey == "" {
		if secret, envErr := secretFromEnvFile(RcloneEnvPath(home)); envErr == nil {
			c.SecretKey = secret
		}
	}
	c.SessionToken = parsed.SessionToken
	c.Endpoint = firstNonEmpty(c.Endpoint, parsed.Endpoint)
	c.Region = firstNonEmpty(c.Region, parsed.Region)
	return c
}

func LoadStorageConfig(endpoint, bucket, prefix, region, downloadURL, secretKey string, fromDisk StorageConfig) (StorageConfig, error) {
	c := StorageConfig{
		Endpoint:     firstNonEmpty(endpoint, os.Getenv("DRIVE_S3_ENDPOINT"), fromDisk.Endpoint),
		Bucket:       firstNonEmpty(bucket, os.Getenv("DRIVE_S3_BUCKET"), fromDisk.Bucket),
		Prefix:       firstNonEmpty(prefix, os.Getenv("DRIVE_S3_PREFIX"), fromDisk.Prefix),
		Region:       firstNonEmpty(region, os.Getenv("DRIVE_S3_REGION"), fromDisk.Region, "us-east-1"),
		AccessKey:    firstNonEmpty(os.Getenv("DRIVE_S3_ACCESS_KEY_ID"), fromDisk.AccessKey),
		SecretKey:    firstNonEmpty(secretKey, fromDisk.SecretKey),
		SessionToken: firstNonEmpty(os.Getenv("DRIVE_S3_SESSION_TOKEN"), fromDisk.SessionToken),
		DownloadURL:  firstNonEmpty(downloadURL, os.Getenv("DRIVE_DOWNLOAD_URL"), fromDisk.DownloadURL),
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
		missing = append(missing, fmt.Sprintf("secret key (%s, --secret-key-stdin, or the config file)", secretEnvName))
	}
	if len(missing) > 0 {
		return c, failf("missing-config", strings.Join(missing, ", "))
	}
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
		{"session token", c.SessionToken},
	} {
		if err := checkConfigValue(f.name, f.value); err != nil {
			return c, err
		}
	}
	if err := checkPrefix(c.Prefix); err != nil {
		return c, err
	}
	return c, nil
}

func checkPrefix(prefix string) error {
	trimmed := strings.Trim(prefix, "/")
	if trimmed == "" {
		return nil
	}
	for _, seg := range strings.Split(trimmed, "/") {
		if seg == ".." {
			return failf("bad-prefix", prefix)
		}
	}
	return nil
}

func checkConfigValue(name, value string) error {
	if strings.ContainsAny(value, "\r\n") {
		return failf("invalid-config", name)
	}
	if strings.Contains(value, "\x00") {
		return failf("invalid-config", name)
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
