package main

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
)

// StorageConfig is the storage endpoint and keys, kept as config so switching
// to the real storage (iDrive e2, step 1) needs no code change. Everything but
// the keys is read from flags, falling back to the environment; the access key
// id is read from the environment only, and the storage secret from the config
// file (mode 0600), the environment, or stdin. A command-line argument is
// visible in `ps` output and in the shell history for as long as the process
// lives, and a device key does not belong in either. Nothing here is
// provider-specific.
type StorageConfig struct {
	Endpoint  string // S3 endpoint URL, e.g. http://127.0.0.1:8080 (stand-in) or https://s3.eu-west-3.idrivee2-<n>.com
	AccessKey string
	SecretKey string
	// SessionToken is the STS token a scoped credential is minted with
	// (workers/api/src/s3-keys.js). A deployment whose keys are permanent has
	// none, and then this is empty and no session_token line is written. A
	// scoped key carries one, and without it the storage server answers
	// InvalidTokenId (measured against the pinned MinIO, issue #241), so the
	// mount would fail to read a drive it is entitled to.
	SessionToken string
	Bucket       string
	Prefix       string // key prefix this device mounts, e.g. /u/<id>/
	Region       string // S3 region name; stand-ins accept any
	// DownloadURL is the dl Worker (drive issue #58, build step 5): the host
	// reads stream through, so the mount's reads land in that account's
	// download bytes. Empty means no download host is configured, and the
	// mount then reads straight from storage and counts nothing, which is the
	// honest state of a local stand-in.
	DownloadURL string
}

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
// vfsCacheMaxValue.
const (
	vfsCacheModeValue        = "full"
	vfsWriteBackValue        = "5s"
	vfsCacheMaxValue         = "20G"
	vfsDirCacheTimeValue     = "5s"   // see VFSArgs: S3 sends no change notifications
	vfsChunkStreamSize       = "32M"  // --buffer-size: in-memory buffer per transfer
	vfsReadAheadValue        = "128k" // first-chunk size: small files stay one VFS read; a video is not pulled in
	vfsReadChunkSizeValue    = "128M" // rclone's own default, named so a round has a value to climb
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
	// has no DRIVE_S3_* environment, and the keys live in rclone.conf.
	PrefetchLaunchdLabel = "com.nishfleet.drive.prefetch"
	// SystemdUnitName is the systemd user unit on Linux (step 3).
	SystemdUnitName = "drive-mount.service"
	// PrefetchSystemdUnitName is the sidecar that runs `drive prefetch`.
	PrefetchSystemdUnitName = "drive-prefetch.service"
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

// ReadSecretKey resolves the storage secret from the safe sources and only
// from those (issue #75). The three sources are a pipe, the environment, and
// the config file this CLI itself wrote, and there is no fourth: no flag, so
// the secret can never be read out of /proc/<pid>/cmdline or out of a shell
// history file, which is the finding this issue opened with.
//
// The order is fixed, not negotiable: an explicit --secret-key-stdin wins over
// the environment, the environment wins over the config file. So a pipe that
// carries nothing is an error rather than a quiet fall-through to the
// environment — someone who asked for the secret to come from the pipe and
// piped nothing has made a mistake, and reading the environment instead would
// mount with a credential they did not choose and did not see.
//
// configPath is the config file to fall back to, and an absent file is not an
// error (there is no key on this machine yet). wantStdin says the caller piped
// a secret in, and a pipe that carries nothing is a mistake rather than a
// missing value: a silent empty secret would mount with no credential and fail
// later with a confusing 403.
func ReadSecretKey(configPath string, wantStdin bool, stdin io.Reader) (string, error) {
	if wantStdin {
		// One line, as the flag says, and one line is what it reads: the read
		// stops at the newline, not at EOF. Reading to EOF would make a pipe
		// whose writer stays open — a process manager, a long-lived producer —
		// hang mount forever, and would make a person at a terminal sit there
		// until they found Ctrl-D. bufio is what the standard library has for
		// exactly this, so it is what this uses — and the same reader is kept
		// for the check below, because a second one would have buffered the rest
		// of the pipe and thrown it away, hiding exactly the second line this
		// is supposed to notice.
		// The reader's buffer IS the cap: ReadSlice stops at the first
		// newline or at a full buffer, and a full buffer with no newline is
		// the over-long line refused below — the bytes never grow past
		// maxSecretBytes no matter how long the pipe's writer hangs on. A
		// plain ReadString would have grown the buffer without limit until it
		// found the newline, which is exactly the disk-image read this cap
		// exists to refuse.
		reader := bufio.NewReaderSize(stdin, maxSecretBytes+1)
		line, err := reader.ReadSlice('\n')
		switch {
		case err == nil || errors.Is(err, io.EOF):
			// the line, or a last line with no newline: both fine
		case errors.Is(err, bufio.ErrBufferFull):
			// The buffer filled before any newline: what is on the pipe is
			// not one short line. Nothing was consumed, so the refusal below
			// is the answer and the bytes are never grown past the cap.
			return "", fmt.Errorf("the storage secret on stdin is longer than %d bytes; --secret-key-stdin reads one line", maxSecretBytes)
		default:
			return "", fmt.Errorf("read the storage secret from stdin: %w", err)
		}
		if len(line) > maxSecretBytes {
			return "", fmt.Errorf("the storage secret on stdin is longer than %d bytes; --secret-key-stdin reads one line", maxSecretBytes)
		}
		// A storage secret is one token, so the blank check and the value agree:
		// surrounding whitespace is a piping mistake, not part of the key, and
		// leaving it on would mount with a secret that is subtly wrong and fail
		// later as a confusing 403.
		secret := strings.TrimSpace(string(line))
		if secret == "" {
			return "", errors.New("no storage secret on stdin: --secret-key-stdin reads one line from the pipe")
		}
		// Anything already buffered after the first line is a caller that
		// piped the wrong thing, and is refused rather than mounted as one
		// long, broken key. Only what the reader already holds is looked at:
		// waiting for a second line would put back the hang the line read just
		// avoided, and a second line that has to be waited for is a pipe this
		// command has no business sitting on.
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
	if env := os.Getenv(secretEnvName); env != "" {
		return env, nil
	}
	if configPath == "" {
		return "", nil
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
	// A FIFO or device is not a config file, and reading one can block forever
	// (a named pipe with no writer hangs mount) or read something that is not
	// the key at all. Only a regular file is read; the mode rule is for regular
	// files anyway.
	if !info.Mode().IsRegular() {
		return fmt.Errorf("%s is not a regular file (mode %s), so it is not the drive config", path, info.Mode())
	}
	// The mode bits are a POSIX concept. On Windows FileMode.Perm() reports
	// 0666/0444 for every file, so the check would refuse every config there;
	// the CLI's other Windows-specific handling lives in the same place
	// (CurrentGOOS), and this is the same kind of platform branch.
	if runtime.GOOS == "windows" {
		return nil
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
// credentials.
//
// The mode rule lives here rather than at the call sites, so no caller can read
// the secret out of a file every user on the machine can read, and none of them
// has to remember to check.
//
// It reports what the file carries rather than insisting on a whole key pair:
// a hand-edited config can hold a secret without the matching id, and the
// caller knows which half it needs. Only a config with no [drive] remote is an
// error, because that is a file this CLI did not write.
func ParseRcloneConfig(path string) (StorageConfig, error) {
	if err := checkSecretFileMode(path); err != nil {
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
		// A remote this CLI does not own is skipped before the line is even
		// looked at, and its lines are never reported: a file can carry other
		// remotes, and one of them having a line rclone tolerates is not this
		// file's problem, let alone this file's business to echo. Only the
		// drive remote is parsed, so no other remote's credentials can be read
		// out of it.
		if section != RcloneRemoteName {
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

// LoadStorageConfig resolves the storage endpoint, bucket, prefix, region and
// the dl Worker's download URL from flags first, then environment variables,
// the access key from the environment alone (DRIVE_S3_ACCESS_KEY_ID), and the
// resolved secret the caller resolved through ReadSecretKey — config file
// (mode 0600), environment, or stdin, and never a flag (issue #75). It fails
// loudly when a required value is missing. Endpoint, bucket and keys are
// config, not code: the same binary talks to the local stand-in or to iDrive e2.
func LoadStorageConfig(endpoint, bucket, prefix, region, downloadURL, secretKey string) (StorageConfig, error) {
	c := StorageConfig{
		Endpoint:     firstNonEmpty(endpoint, os.Getenv("DRIVE_S3_ENDPOINT")),
		Bucket:       firstNonEmpty(bucket, os.Getenv("DRIVE_S3_BUCKET")),
		Prefix:       firstNonEmpty(prefix, os.Getenv("DRIVE_S3_PREFIX")),
		Region:       firstNonEmpty(region, os.Getenv("DRIVE_S3_REGION"), "us-east-1"),
		AccessKey:    os.Getenv("DRIVE_S3_ACCESS_KEY_ID"),
		SecretKey:    secretKey,
		SessionToken: os.Getenv("DRIVE_S3_SESSION_TOKEN"),
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

// RcloneConfig renders the drive-managed rclone config file. The remote is an
// S3 backend pointed at this device's storage endpoint and key; s3v4 is the
// stock signature version every S3-compatible provider accepts.
//
// A scoped key is an STS session, and rclone signs it with the session token
// (issue #241): the line is written only when the credential carries one,
// because a deployment with permanent credentials has none and an empty value
// would sign with an empty token.
//
// no_check_bucket is required for those same scoped keys. rclone's S3 backend
// HeadBucket/CreateBucket-checks the bucket before a PutObject, including
// when a remount drains the VFS cache. A drive key's session policy has
// neither action (workers/api/src/s3-keys.js), so that check is 403 and the
// queued file never goes up — which is the cap-raise path issue #241 proves.
func RcloneConfig(c StorageConfig) string {
	var b strings.Builder
	fmt.Fprintf(&b, "[%s]\n", RcloneRemoteName)
	b.WriteString("type = s3\n")
	b.WriteString("provider = Other\n")
	fmt.Fprintf(&b, "access_key_id = %s\n", c.AccessKey)
	fmt.Fprintf(&b, "secret_access_key = %s\n", c.SecretKey)
	if c.SessionToken != "" {
		fmt.Fprintf(&b, "session_token = %s\n", c.SessionToken)
	}
	fmt.Fprintf(&b, "endpoint = %s\n", c.Endpoint)
	fmt.Fprintf(&b, "region = %s\n", c.Region)
	b.WriteString("no_check_bucket = true\n")
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
	if r.SessionToken != "" {
		r.SessionToken = "<redacted>"
	}
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
