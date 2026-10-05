package main

import (
	"flag"
	"fmt"
	"io"
	"os"
	"os/exec"
	"runtime"
	"strings"
)

// defaultAPIBase is the one host that fronts both /api/* and /v1/* (drive#156).
// It matches src/seo.js SITE_ORIGIN; TestDefaultAPIBaseMatchesTheShippedSite
// fails if they drift. --api and DRIVE_API_URL still win.
const defaultAPIBase = "https://drive-pricing.nishant345.workers.dev"

// openURL opens the device-approve page. Tests replace it so the stand-in
// never needs a display.
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

func deviceName() string {
	name, err := os.Hostname()
	if err != nil || strings.TrimSpace(name) == "" {
		return "this device"
	}
	return name
}

// Login is `drive login`: device sign-in, mint this device's key, write the
// storage settings so `drive init` and `drive mount` need no pasted keys.
func Login(home, apiBase string, out io.Writer) error {
	if strings.TrimSpace(apiBase) == "" {
		return fail("no-api")
	}
	client, err := NewAPIClient(apiBase, "")
	if err != nil {
		return err
	}
	token, account, err := SignIn(client, deviceName(), out)
	if err != nil {
		return err
	}
	client.Token = token
	previous, err := LoadCredentials(home)
	if err != nil {
		return err
	}
	key, err := client.MintKey("device", deviceName())
	if err != nil {
		return err
	}
	if previous.KeyID != "" && previous.KeyID != key.KeyID {
		if err := client.RevokeKey(previous.KeyID); err != nil && !isAPIStatus(err, "404") {
			return fmt.Errorf("revoke the previous device key: %w", err)
		}
	}
	cfg := StorageConfig{
		Endpoint:     key.Endpoint,
		AccessKey:    key.AccessKeyID,
		SecretKey:    key.Secret,
		SessionToken: key.SessionToken,
		Bucket:       key.Bucket,
		Prefix:       key.Prefix,
		Region:       firstNonEmpty(key.Region, "us-east-1"),
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
		APIBase:      client.Base,
		DeviceToken:  token,
		AccountID:    account.ID,
		AccountName:  account.Name,
		AccountEmail: account.Email,
		Endpoint:     cfg.Endpoint,
		Bucket:       cfg.Bucket,
		Prefix:       cfg.Prefix,
		Region:       cfg.Region,
		AccessKeyID:  cfg.AccessKey,
		KeyID:        key.KeyID,
	}
	if err := SaveCredentials(home, creds); err != nil {
		return err
	}
	if err := WriteFileAtomic(RcloneConfigPath(home), []byte(RcloneConfig(cfg)), 0o600); err != nil {
		return err
	}
	if err := WriteRcloneEnv(home, cfg, "", ""); err != nil {
		return err
	}
	who := accountLabel(account)
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
	common := addCommonFlags(fs)
	if err := fs.Parse(args); err != nil {
		return errFlagParse
	}
	if fs.NArg() > 0 {
		return usageFailure(usage, fmt.Sprintf("unexpected argument %q", fs.Arg(0)))
	}
	return Login(common.home, *api, os.Stdout)
}
