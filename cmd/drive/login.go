package main

import (
	_ "embed"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"os"
	"os/exec"
	"runtime"
	"strings"
)

//go:embed site.json
var siteAddress []byte

var defaultAPIBase = mustSiteOrigin()

func mustSiteOrigin() string {
	var site struct {
		Origin string `json:"origin"`
	}
	if err := json.Unmarshal(siteAddress, &site); err != nil {
		panic("drive: site.json is not valid JSON: " + err.Error())
	}
	if !strings.HasPrefix(site.Origin, "https://") {
		panic("drive: site.json origin must be an https address, got " + site.Origin)
	}
	return site.Origin
}

var openURL = openBrowser

func openBrowser(raw string) error {
	switch runtime.GOOS {
	case "darwin":
		return exec.Command("open", raw).Start()
	case "windows":
		return exec.Command("rundll32", "url.dll,FileProtocolHandler", raw).Start()
	default:
		return exec.Command("xdg-open", raw).Start()
	}
}

func deviceName(flag, hostname string) string {
	if set := strings.TrimSpace(flag); set != "" {
		if name := SanitizeDevice(set); name != "" {
			return name
		}
	}
	if strings.TrimSpace(hostname) == "" {
		return "this device"
	}
	if name := SanitizeDevice(stockedHostname(hostname)); name != "" {
		return name
	}
	return "this device"
}

func osHostname() string {
	name, err := os.Hostname()
	if err != nil {
		return ""
	}
	return name
}

func loginDeviceName(flag, previous string) string {
	return deviceName(firstNonEmpty(
		strings.TrimSpace(flag),
		strings.TrimSpace(os.Getenv(deviceEnvName)),
		strings.TrimSpace(previous),
	), osHostname())
}

func envDeviceName(home string) string {
	previous := ""
	if creds, err := LoadCredentials(home); err == nil {
		previous = creds.Device
	}
	return loginDeviceName("", previous)
}

// Login is `drive login`: device sign-in, mint this device's key, write the storage settings so `drive init` and `drive mount` need no pasted keys.
func Login(home, apiBase, device string, out io.Writer) error {
	if strings.TrimSpace(apiBase) == "" {
		return fail("no-api")
	}
	client, err := NewAPIClient(apiBase, "")
	if err != nil {
		return err
	}
	previous, loadErr := LoadCredentials(home)
	if loadErr != nil {
		previous = Credentials{}
	}
	name := loginDeviceName(device, previous.Device)
	token, err := SignIn(client, name, out)
	if err != nil {
		return err
	}
	client.Token = token.Token
	key, err := client.MintKey("device", name)
	if err != nil {
		return err
	}
	cfg := StorageConfig{
		Endpoint:     key.Endpoint,
		AccessKey:    key.AccessKeyID,
		SecretKey:    key.Secret,
		SessionToken: key.SessionToken,
		Bucket:       key.Bucket,
		Prefix:       key.Prefix,
		Region:       firstNonEmpty(key.Region, "us-east-1"),
		DownloadURL:  key.DownloadURL,
	}
	if cfg.Endpoint == "" || cfg.Bucket == "" || cfg.AccessKey == "" || cfg.SecretKey == "" {
		missing := []string{}
		if cfg.Endpoint == "" {
			missing = append(missing, "endpoint")
		}
		if cfg.Bucket == "" {
			missing = append(missing, "bucket")
		}
		if cfg.AccessKey == "" {
			missing = append(missing, "access key")
		}
		if cfg.SecretKey == "" {
			missing = append(missing, "secret key")
		}
		return failf("login-no-storage", strings.Join(missing, ", "))
	}
	creds := Credentials{
		APIBase:        client.Base,
		DeviceToken:    token.Token,
		TokenExpiresAt: token.ExpiresAt,
		AccountID:      token.Account.ID,
		AccountName:    token.Account.Name,
		AccountEmail:   token.Account.Email,
		Endpoint:       cfg.Endpoint,
		Bucket:         cfg.Bucket,
		Prefix:         cfg.Prefix,
		Region:         cfg.Region,
		DownloadURL:    cfg.DownloadURL,
		AccessKeyID:    cfg.AccessKey,
		KeyID:          key.KeyID,
		Device:         name,
	}
	if key.ExpiresAt != nil {
		creds.KeyExpiresAt = *key.ExpiresAt
	}
	if key.ExpiresIn > 0 {
		creds.KeyTTLSeconds = int64(key.ExpiresIn)
	}
	if err := SaveCredentials(home, creds); err != nil {
		return err
	}
	if err := WriteFileAtomic(RcloneConfigPath(home), []byte(RcloneConfig(cfg)), 0o600); err != nil {
		return err
	}
	if err := WriteRcloneEnv(home, cfg, "", "", ""); err != nil {
		return err
	}
	if previous.DeviceToken != "" && previous.DeviceToken != token.Token {
		base := previous.APIBase
		if base == "" {
			base = apiBase
		}
		old, err := NewAPIClient(base, previous.DeviceToken)
		if err == nil {
			err = old.ClearQueueReport()
		}
		if err != nil && !isAPIStatus(err, "401") && !isAPIStatus(err, "404") {
			fmt.Fprintf(out, "note: the previous login's upload queue could not be cleared (%v); it ages out in 15 minutes\n", err)
		}
	}
	if previous.KeyID != "" && previous.KeyID != key.KeyID {
		if err := client.RevokeKey(previous.KeyID); err != nil && !isAPIStatus(err, "404") {
			fmt.Fprintf(out, "note: the previous device key could not be revoked (%v); it is still live\n", err)
		}
	}
	who := accountLabel(token.Account)
	if who == "" {
		fmt.Fprintln(out, "Signed in. Storage settings written. Run `drive init` to mount.")
		return nil
	}
	fmt.Fprintf(out, "Signed in as %s. Storage settings written. Run `drive init` to mount.\n", who)
	return nil
}

func runLogin(args []string) error {
	fs := flag.NewFlagSet("login", flag.ContinueOnError)
	api := fs.String("api", firstNonEmpty(os.Getenv("DRIVE_API_URL"), defaultAPIBase), "api Worker base URL")
	device := fs.String("device", "", "name this device is called in the account (default: DRIVE_DEVICE, else the name a previous login saved, else the hostname, with a suffix when it is a stock model name)")
	common := addCommonFlags(fs)
	if err := fs.Parse(args); err != nil {
		return errFlagParse
	}
	if fs.NArg() > 0 {
		return usageFailure(usage, fmt.Sprintf("unexpected argument %q", fs.Arg(0)))
	}
	return Login(common.home, *api, *device, os.Stdout)
}
