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
	// (core/s3-keys.js). A deployment whose keys are permanent has
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

// Default paths, overridable for tests.
func DefaultConfigDir(home string) string { return filepath.Join(home, ".config", "drive") }
func DefaultMountDir(home string) string  { return filepath.Join(home, "Drive") }
func DefaultCacheDir(home string) string  { return filepath.Join(home, ".cache", "drive", "vfs") }
func RcloneConfigPath(home string) string {
	return filepath.Join(DefaultConfigDir(home), "rclone.conf")
}

// RcloneEnvPath is the 0600 EnvironmentFile the mount writes for rclone:
// the remote-control user/password and the storage secret as rclone's own
// RCLONE_CONFIG_<REMOTE>_* variables. systemd reads it with EnvironmentFile=;
// launchd gets the same values as EnvironmentVariables in a 0600 plist. The
// secret does not sit in rclone.conf (drive#498).
func RcloneEnvPath(home string) string {
	return filepath.Join(DefaultConfigDir(home), "rclone.env")
}

const (
	// RcloneRemoteName is the remote name this product owns in the rclone config.
	RcloneRemoteName = "drive"
)

// SecretEnvName is the environment variable that carries the storage secret.
// It is the one the mount has always read; a flag alongside it is what this
// issue removed, because a flag is in the shell history and in ps for every
// user on the machine for as long as the process lives.
const SecretEnvName = "DRIVE_S3_SECRET_ACCESS_KEY"

// rclone's own environment names for the mount process (rclone.org/docs
// "Environment Variables"): --rc-user/--rc-pass become RCLONE_RC_USER /
// RCLONE_RC_PASS, and a config key on the drive remote becomes
// RCLONE_CONFIG_DRIVE_<KEY>. The systemd unit is 0644, so these live in the
// 0600 EnvironmentFile rather than an Environment= line in the unit.
const (
	RCUserEnv = "RCLONE_RC_USER"
	RCPassEnv = "RCLONE_RC_PASS"
	SecretEnv = "RCLONE_CONFIG_DRIVE_SECRET_ACCESS_KEY"
	// RCAddrEnv is the environment variable that carries the remote control's
	// loopback address. Two mounts on one host cannot both bind one address
	// (drive#807), so a person's mount picks a free loopback port and stores it
	// in rclone.env under this name. DRIVE_RC_ADDR and --rc-addr still override,
	// which is how the two-machine proof (issue #30) and the tests pin a port.
	RCAddrEnv = "DRIVE_RC_ADDR"
	// DownloadURLEnv is the S3 backend's download_url (the dl Worker).
	// The URL carries the key's download grant (drive#517), so it rides with
	// the secret in the 0600 environment and never on rclone's command line,
	// where any local process could read it from the process list.
	DownloadURLEnv = "RCLONE_CONFIG_DRIVE_DOWNLOAD_URL"
)

// MaxSecretBytes bounds what a pipe can hand over. A storage secret is one
// short line; this exists so `--secret-key-stdin` cannot be pointed at a disk
// image and read the whole thing into the process.
const MaxSecretBytes = 64 << 10

// ReadSecretKey resolves the storage secret from the safe sources and only
// from those (issue #75, drive#498). The sources are a pipe, the environment,
// the 0600 rclone.env this CLI wrote, and a leftover secret line in rclone.conf
// from before #498. There is no flag: the secret can never be read out of
// /proc/<pid>/cmdline or a shell history file.
//
// The order is fixed, not negotiable: an explicit --secret-key-stdin wins over
// the environment, the environment wins over rclone.env, rclone.env wins over
// rclone.conf. So a pipe that carries nothing is an error rather than a quiet
// fall-through — someone who asked for the secret to come from the pipe and
// piped nothing has made a mistake, and reading the environment instead would
// mount with a credential they did not choose and did not see.
//
// configPath is the rclone.conf beside rclone.env, and an absent file is not an
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
		// MaxSecretBytes no matter how long the pipe's writer hangs on. A
		// plain ReadString would have grown the buffer without limit until it
		// found the newline, which is exactly the disk-image read this cap
		// exists to refuse.
		reader := bufio.NewReaderSize(stdin, MaxSecretBytes+1)
		line, err := reader.ReadSlice('\n')
		switch {
		case err == nil || errors.Is(err, io.EOF):
			// the line, or a last line with no newline: both fine
		case errors.Is(err, bufio.ErrBufferFull):
			// The buffer filled before any newline: what is on the pipe is
			// not one short line. Nothing was consumed, so the refusal below
			// is the answer and the bytes are never grown past the cap.
			return "", fmt.Errorf("the storage secret on stdin is longer than %d bytes; --secret-key-stdin reads one line", MaxSecretBytes)
		default:
			return "", fmt.Errorf("read the storage secret from stdin: %w", err)
		}
		if len(line) > MaxSecretBytes {
			return "", fmt.Errorf("the storage secret on stdin is longer than %d bytes; --secret-key-stdin reads one line", MaxSecretBytes)
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

// checkSecretFileMode refuses a config file other users can read before the
// secret in it is read. A 0644 rclone.conf is the storage secret in every
// shell's reach on the machine, the same exposure as the flag this issue
// removed, so the error names the mode and the fix.
func CheckSecretFileMode(path string) error {
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

// RcloneConfig renders the drive-managed rclone config file. The remote is an
// S3 backend pointed at this device's storage endpoint and key; s3v4 is the
// stock signature version every S3-compatible provider accepts. The storage
// secret is not a line in this file (drive#498): rclone reads it from
// RCLONE_CONFIG_DRIVE_SECRET_ACCESS_KEY at mount time.
//
// A scoped key is an STS session, and rclone signs it with the session token
// (issue #241): the line is written only when the credential carries one,
// because a deployment with permanent credentials has none and an empty value
// would sign with an empty token.
//
// no_check_bucket is required for those same scoped keys. rclone's S3 backend
// HeadBucket/CreateBucket-checks the bucket before a PutObject, including
// when a remount drains the VFS cache. A drive key's session policy has
// neither action (core/s3-keys.js), so that check is 403 and the
// queued file never goes up — which is the cap-raise path issue #241 proves.
// A permanent key can HeadBucket, so the line is only written when a session
// token is present.
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

// RcloneConfigRedacted renders the same config for display, with the access
// key replaced by a placeholder. `drive mount --dry-run` prints this, so a dry
// run on a shared screen or in a terminal transcript can never leak the
// device's keys. The storage secret is not a line in rclone.conf (drive#498).
func RcloneConfigRedacted(c StorageConfig) string {
	r := c
	r.AccessKey = "<redacted>"
	r.SecretKey = ""
	if r.SessionToken != "" {
		r.SessionToken = "<redacted>"
	}
	return RcloneConfig(r)
}

// EnvPathBeside is rclone.env next to the rclone.conf path ReadSecretKey
// already holds, so the two files stay a pair without a second home argument.
func EnvPathBeside(configPath string) string {
	if configPath == "" {
		return ""
	}
	return filepath.Join(filepath.Dir(configPath), "rclone.env")
}

// RCAuth is the random user and password the mount generates for rclone's
// remote control, and the loopback address that mount bound. They live in
// rclone.env (mode 0600) and are what --rc-user / --rc-pass, --rc-addr and
// the one rc client send (drive#498, drive#807).
type RCAuth struct {
	User string
	Pass string
	Addr string
}

// WriteRcloneEnv writes the 0600 EnvironmentFile rclone and systemd read: the
// remote-control user/password (hex, so they need no quoting), the loopback
// address that mount bound (drive#807), and the storage secret as rclone's
// own RCLONE_CONFIG_DRIVE_SECRET_ACCESS_KEY. An empty rc user (login, before
// the first mount) writes only the secret.
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

// ReadRCAuth reads the remote-control user, password and bound address from
// rclone.env.
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

// EnvQuote quotes a value for systemd's EnvironmentFile and for this
// CLI's own parser: double quotes, with \, ", $ and ` escaped, so a storage
// secret cannot break out of its line.
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
