package main

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

// vfsCacheModeValue, vfsWriteBackValue, vfsCacheMaxValue,
// vfsDirCacheTimeValue, vfsChunkStreamSize, vfsReadAheadValue,
// vfsReadChunkSizeValue, vfsReadChunkStreamsValue and vfsTransfersValue
// are the stock rclone VFS flags this product mounts with. They are the same
// on Mac (nfsmount) and Linux (mount), and mount.go VFSArgs is the one place
// that turns them into an argument vector.
//
// The four that decide durability and freshness stay pinned: cache mode,
// write-back, cache max size, and dir-cache-time. Issue #224's hill-climb
// may move only the speed knobs (chunk size, chunk streams, buffer size,
// read-ahead, transfers). TestVFSArgsPinsTheSafetyFlags fails if a round
// trades away a pinned value. Write-back must still land inside the 5s
// window docs/build-spec.md names, and nothing may be cached past
// vfsCacheMaxValue. The chunk pair is bounded too (issue #543): rclone's
// parallel reader allocates one chunk buffer per stream, so chunk size x
// streams must stay at or under 128 MiB per open file, and
// TestVFSReadChunkingBoundsPerFileMemory fails on a bigger product.
const (
	vfsCacheModeValue        = "full"
	vfsWriteBackValue        = "5s"
	vfsCacheMaxValue         = "20G"
	vfsDirCacheTimeValue     = "24h"  // issue #541: a kept-offline folder still opens after the network has been down; listings stay fresh via vfs/refresh from the fill loop while storage answers
	vfsChunkStreamSize       = "32M"  // --buffer-size: in-memory buffer per transfer
	vfsReadAheadValue        = "128k" // first-chunk size: small files stay one VFS read; a video is not pulled in
	vfsReadChunkSizeValue    = "32M"  // one read buffer per stream; 32M x 2 streams = 64 MiB per open file (issue #543)
	vfsReadChunkStreamsValue = "2"    // Two streams is what main shipped (issue #227); rclone's own default is 4.
	vfsTransfersValue        = "4"    // rclone's own default, named so a round has a value to climb

	// vfsCacheMinFreeSpaceValue is the free space rclone keeps on the disk the
	// cache lives on, and it is on every mount (issue #112).
	// --vfs-cache-max-size caps how big the cache may get; this flag is what
	// makes that cap honest about the disk it sits on, because rclone evicts
	// down to this much free space even if the max-size cap would otherwise
	// let the cache take it: a 20 GiB cap on a machine with little disk free
	// cannot fill that disk. It is not tunable, so there is one floor in the
	// product and not one in the CLI and another in the mount. It is a floor
	// of *free* space, never of used space, so it can only ever shrink the
	// cache the max-size cap allows, never grow it.
	vfsCacheMinFreeSpaceValue = "1G"
)

// ---- the cache limit (issue #112) ----

// CacheMaxPath is where the limit the person chose for the mount's cache lives.
// It is in the drive config dir next to rclone.conf, is not a secret, and is
// deleted by the same `drive logout` that deletes the config dir. Absent means
// the person never chose a limit and the shipped 20G default applies.
func CacheMaxPath(home string) string {
	return filepath.Join(DefaultConfigDir(home), "cache-max")
}

// ResolveCacheMax is the limit the mount must run with: whatever the person set
// with `drive cache --max`, or the shipped vfsCacheMaxValue default. A file
// that holds something rclone would refuse ("20Z", "ten") is a named error
// carrying the offending value and the file, never a silent fall back to the
// default: a mount that quietly used 20G after the person typed 5G would be a
// lie about where the bytes are, and the whole point of #112 is that the
// number on screen is the number on disk.
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

// SaveCacheMax validates the typed limit with rclone's own SizeSuffix parser
// and writes it for the next mount. It refuses zero: rclone treats
// --vfs-cache-max-size 0 as no cache at all, which would take the live mount's
// cache away from a person who typed a digit by mistake.
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

// userHomeDir is the operating system's own answer to "whose home is this",
// held in a variable so a test can stand in for the platform's answer: the
// Windows branch cannot be run on a Linux runner, and the bug this replaced
// was a Windows one (drive#544).
var userHomeDir = os.UserHomeDir

// DefaultHome is the home directory every default path hangs off. It is
// os.UserHomeDir, never os.Getenv("HOME"): Windows exports no HOME, so the
// environment read joined `.config/drive` and `.cache/drive/vfs` onto an
// empty string, and `drive login` in PowerShell wrote
// `\.config\drive\rclone.conf` under whatever folder the command ran from
// (drive#544). os.UserHomeDir answers USERPROFILE on Windows and HOME on every
// other platform, so one call is the answer on all of them, and the flag
// default below cannot be dragged back to a relative path by a platform that
// never sets HOME. An answer the OS cannot give stays empty, which is what
// the environment read did when nothing was set: the path builders then
// resolve relative to whatever folder the command ran from, the same as
// before this change. That fallback is reached only on a platform where the
// OS reports no home at all, not on the Windows case this fixes (there
// USERPROFILE is set for every interactive login). Turning it into a hard
// error would change every string-returning path builder and all of their
// callers, which is wider than this fix; a caller on such a platform passes
// --home to name an absolute root explicitly.
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
	// PrefetchLaunchdLabel is the second login item that warms the next folder
	// after a listing (issue #227). The mount item stays rclone: a login item
	// has no DRIVE_S3_* environment, and the storage secret lives in rclone.env.
	PrefetchLaunchdLabel = "com.nishfleet.drive.prefetch"
	// SystemdUnitName is the systemd user unit on Linux (step 3).
	SystemdUnitName = "drive-mount.service"
	// PrefetchSystemdUnitName is the sidecar that runs `drive prefetch`.
	PrefetchSystemdUnitName = "drive-prefetch.service"
)

// secretWays names every safe way to hand the storage secret to `drive mount`,
// in the order a caller should reach for them, with the config file this run
// would read. It is printed by the error that refuses the flag it replaced, so
// a person upgrading sees what to do instead of only what stopped working. The
// example is a redirect, never a printf of a variable: a shell that expands a
// secret variable into a command line puts the secret back in the argv this
// change exists to keep it out of.
func secretWays(configPath string) string {
	return fmt.Sprintf(`the storage secret is not accepted on the command line; put it in
  1. the 0600 env file %s
  2. the environment: DRIVE_S3_SECRET_ACCESS_KEY
  3. --secret-key-stdin, from a redirect or a pipe, as in
     drive mount --secret-key-stdin < secret-file
     or  pass show drive/s3-secret | drive mount --secret-key-stdin
where the secret is never in the command line, the shell history or ps`, rcloneEnvPathBeside(configPath))
}

// LoadStorageConfig resolves the storage endpoint, bucket, prefix, region and
// the dl Worker's download URL from flags first, then environment variables,
// the access key from the environment alone (DRIVE_S3_ACCESS_KEY_ID), and the
// resolved secret the caller resolved through ReadSecretKey — config file
// (mode 0600), environment, or stdin, and never a flag (issue #75). It fails
// loudly when a required value is missing. Endpoint, bucket and keys are
// config, not code: the same binary talks to the local stand-in or to iDrive e2.
// storageFromDisk is what `drive login` wrote: credentials hold the location,
// rclone.env holds the storage secret, rclone.conf holds the access key and
// endpoint. Empty when this machine has not logged in.
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
		// The download host is optional and has no default: with none set the
		// mount reads straight from storage (the local stand-in case), and with
		// one set rclone streams every read through the dl Worker, which counts
		// the bytes into that account's download total (docs/build-spec.md
		// "The pieces", items 2 and 4).
		DownloadURL: firstNonEmpty(downloadURL, os.Getenv("DRIVE_DOWNLOAD_URL"), fromDisk.DownloadURL),
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
		{"session token", c.SessionToken},
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
			return failf("bad-prefix", prefix)
		}
	}
	return nil
}

// checkConfigValue rejects a value that would break out of its line in the
// generated rclone config.
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
