package main

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"html"
	"io/fs"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"
)

// Device-key renewal (drive#749). A device key minted over a provider that
// names a session (STS) dies when that session ends. The Worker re-mints under
// the same row id (POST /v1/keys/<id>/renew). This file is the CLI half: it
// asks before the session ends, writes the fresh credential into rclone.conf
// and rclone.env, and reloads the remote. The VFS cache is not touched, so
// queued uploads stay queued (the same promise RestartMount makes for a cap
// swap).
//
// The loop runs two ways, matching prefetch: inside `drive mount --foreground`
// as a goroutine, and as a sidecar login item for the systemd/launchd mount
// that runs rclone itself. The sidecar is not PartOf the mount unit, so it can
// restart rclone without being stopped with it.

const (
	// deviceKeyRenewFraction is how far through a session the CLI asks for a
	// fresh credential. 0.8 is the orchestrator's default on drive#749: a
	// one-hour STS session is renewed at 48 minutes, with 12 minutes of slack
	// for a slow Worker.
	deviceKeyRenewFraction = 0.8
	// deviceKeyRenewTick is how often the loop re-reads credentials while it
	// waits. A shorter tick would spin; a longer one could overshoot the
	// 80 percent mark on a short session.
	deviceKeyRenewTick = 30 * time.Second
	// deviceKeyRenewMargin is the fallback when a credentials file carries an
	// expiry but no TTL (a file written before this loop stored the lifetime).
	deviceKeyRenewMargin = 5 * time.Minute
)

// DeviceRenewLaunchdLabel is the macOS login item that runs `drive renew`.
const DeviceRenewLaunchdLabel = "com.nishfleet.drive.renew"

// DeviceRenewSystemdUnitName is the Linux sidecar that runs `drive renew`.
const DeviceRenewSystemdUnitName = "drive-renew.service"

func deviceRenewEnabled() bool { return os.Getenv("DRIVE_DEVICE_RENEW") != "0" }

// DeviceRenewStatePath is the file `drive status` reads when a renew failed.
func DeviceRenewStatePath(home string) string {
	return filepath.Join(DefaultConfigDir(home), "device-key-renew.json")
}

func DeviceRenewLaunchdPlistPath(home string) string {
	return filepath.Join(home, "Library", "LaunchAgents", DeviceRenewLaunchdLabel+".plist")
}

func DeviceRenewSystemdUnitPath(home string) string {
	return filepath.Join(home, ".config", "systemd", "user", DeviceRenewSystemdUnitName)
}

func DeviceRenewLoginItemPath(goos, home string) string {
	switch goos {
	case "darwin":
		return DeviceRenewLaunchdPlistPath(home)
	case "windows":
		return ""
	default:
		return DeviceRenewSystemdUnitPath(home)
	}
}

func DeviceRenewLoginItem(goos, driveBin, home string) string {
	switch goos {
	case "darwin":
		return deviceRenewLaunchdPlist(driveBin, home)
	case "windows":
		return ""
	default:
		return deviceRenewSystemdUnit(driveBin, home)
	}
}

func deviceRenewSystemdUnit(driveBin, home string) string {
	execStart := systemdEscapeArg(driveBin) + " renew --home " + systemdEscapeArg(home)
	return fmt.Sprintf(`[Unit]
Description=drive: renew an expiring device key before the vendor session ends
After=%s

[Service]
Type=simple
ExecStart=%s
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
`, SystemdUnitName, execStart)
}

func deviceRenewLaunchdPlist(driveBin, home string) string {
	var b strings.Builder
	b.WriteString("<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n")
	b.WriteString("<!DOCTYPE plist PUBLIC \"-//Apple//DTD PLIST 1.0//EN\" \"http://www.apple.com/DTDs/PropertyList-1.0.dtd\">\n")
	b.WriteString("<plist version=\"1.0\">\n<dict>\n")
	fmt.Fprintf(&b, "\t<key>Label</key>\n\t<string>%s</string>\n", html.EscapeString(DeviceRenewLaunchdLabel))
	b.WriteString("\t<key>ProgramArguments</key>\n\t<array>\n")
	for _, a := range []string{driveBin, "renew", "--home", home} {
		fmt.Fprintf(&b, "\t\t<string>%s</string>\n", html.EscapeString(a))
	}
	b.WriteString("\t</array>\n")
	b.WriteString("\t<key>RunAtLoad</key>\n\t<true/>\n")
	b.WriteString("\t<key>KeepAlive</key>\n\t<true/>\n")
	b.WriteString("</dict>\n</plist>\n")
	return b.String()
}

func startDeviceRenewLoginItem(goos, home, itemPath string) error {
	if !deviceRenewEnabled() || goos == "windows" || itemPath == "" {
		return nil
	}
	if goos == "darwin" {
		return bootstrapLaunchdLabel(DeviceRenewLaunchdLabel, itemPath)
	}
	for _, action := range []string{"daemon-reload", "enable", "restart"} {
		args := []string{"--user", action}
		if action != "daemon-reload" {
			args = append(args, DeviceRenewSystemdUnitName)
		}
		if err := exec.Command("systemctl", args...).Run(); err != nil {
			return fmt.Errorf("systemctl %s: %w", strings.Join(args, " "), err)
		}
	}
	return nil
}

func stopDeviceRenewLoginItem(goos, home string) error {
	if goos == "windows" {
		return nil
	}
	itemPath := DeviceRenewLoginItemPath(goos, home)
	if _, err := os.Stat(itemPath); err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			return nil
		}
		return fmt.Errorf("stat %s: %w", itemPath, err)
	}
	if goos == "darwin" {
		return bootoutLaunchdLabel(DeviceRenewLaunchdLabel, itemPath)
	}
	if err := exec.Command("systemctl", "--user", "disable", "--now", DeviceRenewSystemdUnitName).Run(); err != nil {
		return fmt.Errorf("systemctl --user disable --now %s: %w", DeviceRenewSystemdUnitName, err)
	}
	return nil
}

// deviceRenewSlack is how long before expiresAt the CLI asks for a fresh
// credential. With a known TTL that is the last 20 percent of the session
// (80 percent used). Without one it is the five-minute agent-key margin.
func deviceRenewSlack(ttlSeconds int64) time.Duration {
	if ttlSeconds > 0 {
		slack := time.Duration(float64(ttlSeconds)*(1-deviceKeyRenewFraction)) * time.Second
		if slack < time.Second {
			return time.Second
		}
		return slack
	}
	return deviceKeyRenewMargin
}

// needsDeviceRenew reports whether this device's storage key should be
// re-minted now. A key with no expiry never needs one (the key-pair path).
func needsDeviceRenew(expiresAt, ttlSeconds int64, now time.Time) bool {
	if expiresAt <= 0 {
		return false
	}
	return !time.Unix(expiresAt, 0).After(now.Add(deviceRenewSlack(ttlSeconds)))
}

func deviceRenewWait(expiresAt, ttlSeconds int64, now time.Time) time.Duration {
	if expiresAt <= 0 || needsDeviceRenew(expiresAt, ttlSeconds, now) {
		if expiresAt <= 0 {
			return deviceKeyRenewTick
		}
		return 0
	}
	wait := time.Unix(expiresAt, 0).Add(-deviceRenewSlack(ttlSeconds)).Sub(now)
	if wait > deviceKeyRenewTick {
		return deviceKeyRenewTick
	}
	if wait < 0 {
		return 0
	}
	return wait
}

type deviceRenewFailure struct {
	FailedAt time.Time `json:"failedAt"`
	What     string    `json:"what"`
}

func recordDeviceRenewFailure(home string, err error) error {
	what := err.Error()
	var f *failure
	if errors.As(err, &f) {
		what = f.What
	}
	body, encErr := json.Marshal(deviceRenewFailure{FailedAt: time.Now().UTC(), What: what})
	if encErr != nil {
		return encErr
	}
	return WriteFileAtomic(DeviceRenewStatePath(home), append(body, '\n'), 0o600)
}

func clearDeviceRenewFailure(home string) error {
	err := os.Remove(DeviceRenewStatePath(home))
	if err != nil && !errors.Is(err, fs.ErrNotExist) {
		return err
	}
	return nil
}

// deviceRenewStatusLine is the named failure `drive status` prints instead of
// "waiting to upload" when a renew did not land. Empty when there is none.
func deviceRenewStatusLine(home string) string {
	data, err := os.ReadFile(DeviceRenewStatePath(home))
	if err != nil {
		return ""
	}
	var st deviceRenewFailure
	if json.Unmarshal(data, &st) != nil || strings.TrimSpace(st.What) == "" {
		return fail("device-key-renew-failed").Error()
	}
	return failDetail("device-key-renew-failed", errors.New(st.What)).Error()
}

// applyDeviceCredential writes the fresh pair into rclone.conf, rclone.env and
// credentials.json. It does not touch the VFS cache directory.
func applyDeviceCredential(home string, creds Credentials, cfg StorageConfig) error {
	if err := checkConfigValue("access key", cfg.AccessKey); err != nil {
		return err
	}
	if err := checkConfigValue("secret key", cfg.SecretKey); err != nil {
		return err
	}
	if cfg.SessionToken != "" {
		if err := checkConfigValue("session token", cfg.SessionToken); err != nil {
			return err
		}
	}
	auth, err := ReadRCAuth(home)
	if err != nil {
		return err
	}
	if err := WriteFileAtomic(RcloneConfigPath(home), []byte(RcloneConfig(cfg)), 0o600); err != nil {
		return err
	}
	if err := WriteRcloneEnv(home, cfg, auth.User, auth.Pass, auth.Addr); err != nil {
		return err
	}
	creds.AccessKeyID = cfg.AccessKey
	if err := SaveCredentials(home, creds); err != nil {
		return err
	}
	return nil
}

func reloadMountedRemote(goos, home, rcloneBin string, cfg StorageConfig) error {
	on, err := Mounted(goos, home)
	if err != nil {
		return err
	}
	if !on {
		return nil
	}
	if goos == "linux" {
		out, activeErr := exec.Command("systemctl", "--user", "is-active", SystemdUnitName).Output()
		if activeErr == nil && strings.TrimSpace(string(out)) == "active" {
			if err := exec.Command("systemctl", "--user", "restart", SystemdUnitName).Run(); err != nil {
				return fmt.Errorf("restart the mount: %w", err)
			}
			return nil
		}
	}
	if goos == "darwin" {
		target := launchctlTarget() + "/" + LaunchdLabel
		if err := exec.Command("launchctl", "kickstart", "-k", target).Run(); err == nil {
			return nil
		}
	}
	if c, rcErr := mountRCClient(home); rcErr == nil {
		if err := c.updateRemoteConfig(cfg); err == nil {
			return nil
		}
	}
	if rcloneBin == "" {
		resolved, resErr := ResolveRclone("")
		if resErr != nil {
			return resErr
		}
		rcloneBin = resolved
	}
	return RestartMount(goos, home, rcloneBin, cfg)
}

func runRenew(args []string) error {
	fs := flag.NewFlagSet("renew", flag.ContinueOnError)
	common := addCommonFlags(fs)
	api := fs.String("api", os.Getenv("DRIVE_API_URL"), "api Worker base URL")
	if err := fs.Parse(args); err != nil {
		return errFlagParse
	}
	if fs.NArg() > 0 {
		return usageFailure(usage, fmt.Sprintf("unexpected argument %q", fs.Arg(0)))
	}
	if !deviceRenewEnabled() {
		return nil
	}
	return runDeviceRenewLoop(context.Background(), common.home, *api)
}

func runDeviceRenewLoop(ctx context.Context, home, api string) error {
	for {
		if ctx.Err() != nil {
			return ctx.Err()
		}
		creds, err := LoadCredentials(home)
		if err != nil {
			return err
		}
		if creds.KeyID == "" || creds.KeyExpiresAt == 0 {
			select {
			case <-ctx.Done():
				return ctx.Err()
			case <-time.After(deviceKeyRenewTick):
			}
			continue
		}
		now := time.Now()
		if !needsDeviceRenew(creds.KeyExpiresAt, creds.KeyTTLSeconds, now) {
			wait := deviceRenewWait(creds.KeyExpiresAt, creds.KeyTTLSeconds, now)
			select {
			case <-ctx.Done():
				return ctx.Err()
			case <-time.After(wait):
			}
			continue
		}
		if err := renewDeviceKeyOnce(home, api, creds); err != nil {
			_ = recordDeviceRenewFailure(home, err)
			select {
			case <-ctx.Done():
				return ctx.Err()
			case <-time.After(deviceKeyRenewTick):
			}
			continue
		}
		if err := clearDeviceRenewFailure(home); err != nil {
			fmt.Fprintf(os.Stderr, "drive: device key renew: could not clear the failure file (%v)\n", err)
		}
	}
}

func renewDeviceKeyOnce(home, api string, creds Credentials) error {
	if creds.KeyID == "" {
		return fail("not-signed-in")
	}
	base, err := resolveAPIBase(home, api)
	if err != nil {
		return err
	}
	client, err := signedInClient(home, base, os.Stderr)
	if err != nil {
		return err
	}
	renewed, err := client.RenewDeviceKey(creds.KeyID)
	if err != nil {
		return failDetail("device-key-renew-failed", err)
	}
	cred := renewed.Credential
	// LoadStorageConfig's sixth string is secretKey (config.go). Passing the
	// disk endpoint/bucket/region in the named slots keeps those fields the
	// values login stored, so a swapped argument would fail the bucket
	// assertions in TestRenewDeviceKeyOnceRewritesBeforeExpiry.
	disk := storageFromDisk(home)
	cfg, err := LoadStorageConfig(disk.Endpoint, disk.Bucket, disk.Prefix, disk.Region, disk.DownloadURL, cred.Secret, disk)
	if err != nil {
		return failDetail("device-key-renew-failed", err)
	}
	cfg.AccessKey = cred.AccessKeyID
	cfg.SessionToken = cred.SessionToken
	cfg.SecretKey = cred.Secret
	if renewed.ExpiresAt != nil {
		creds.KeyExpiresAt = *renewed.ExpiresAt
	}
	if cred.ExpiresIn > 0 {
		creds.KeyTTLSeconds = int64(cred.ExpiresIn)
	}
	if err := applyDeviceCredential(home, creds, cfg); err != nil {
		return failDetail("device-key-renew-failed", err)
	}
	rcloneBin, _ := ResolveRclone("")
	if err := reloadMountedRemote(CurrentGOOS(), home, rcloneBin, cfg); err != nil {
		return failDetail("device-key-renew-failed", err)
	}
	return nil
}
