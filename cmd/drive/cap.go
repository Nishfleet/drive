package main

import (
	"flag"
	"fmt"
	"os"
	"strings"
)

// CAP_PATH is the pricing Worker's spending-cap write (src/cap.js
// `handleCapRequest`). `drive cap` posts here so the amount is parsed by
// parseCapUsd() on the Worker, not rebuilt in Go: a bad amount prints that
// function's own reason.
const CAP_PATH = "/api/cap"

// CapAnswer is POST /api/cap's body: the new cap line `drive status` will
// print, whether the mount has to restart so rclone picks up a swapped key,
// and — when a key was actually swapped — the credential that replaced it.
// Mount.Restart is src/cap.js `capSwapPlan().mount.restart`.
//
// Credential is the swap's own key, minted server-side (the api holds the
// storage master credential), so it exists on this device only in this answer.
// A restart that wrote the key the CLI already had would leave the mount
// holding the pre-cap credential forever, which is the state drive issue #241
// exists to end. Nil when nothing was swapped.
type CapAnswer struct {
	CapLine    string          `json:"capLine"`
	Error      string          `json:"error"`
	Credential *SwapCredential `json:"credential"`
	Mount      struct {
		Restart bool    `json:"restart"`
		Reason  *string `json:"reason"`
	} `json:"mount"`
}

// SwapCredential is the credential a cap swap minted, in the shape the rclone
// config signs with. SessionToken is the STS token a scoped key carries; it is
// empty for a deployment with permanent keys, and then no session_token line
// is written.
type SwapCredential struct {
	AccessKeyID  string `json:"accessKeyId"`
	Secret       string `json:"secret"`
	SessionToken string `json:"sessionToken"`
}

// runCap is `drive cap <dollars>`: POST the typed amount, print the Worker's
// cap line, and restart the mount when the swap says so, without touching the
// VFS cache (issue #64).
func runCap(args []string) error {
	fs := flag.NewFlagSet("cap", flag.ContinueOnError)
	common := addCommonFlags(fs)
	api := fs.String("api", os.Getenv("DRIVE_API_URL"), "api Worker base URL")
	if err := fs.Parse(args); err != nil {
		return errFlagParse
	}
	amount := strings.TrimSpace(strings.Join(fs.Args(), " "))
	if amount == "" {
		return fmt.Errorf("a spending cap is a dollar amount like 20 or 12.50. Run: drive cap 20")
	}
	home := common.home
	creds, err := LoadCredentials(home)
	if err != nil {
		return err
	}
	base := strings.TrimSpace(*api)
	if base == "" {
		base = creds.APIBase
	}
	client, err := NewAPIClient(base, creds.DeviceToken)
	if err != nil {
		return err
	}
	var answer CapAnswer
	if err := client.post(CAP_PATH, map[string]string{"amount": amount}, &answer); err != nil {
		return err
	}
	if strings.TrimSpace(answer.CapLine) != "" {
		fmt.Println(answer.CapLine)
	}
	if !answer.Mount.Restart {
		return nil
	}
	rcloneBin, err := ResolveRclone(common.rclone)
	if err != nil {
		return err
	}
	// The swap's own credential is what the mount must sign with (issue #241).
	// It was minted server-side and exists nowhere on this device yet, so when
	// the answer carries one it is written instead of the pre-cap key: the
	// whole point of the restart is that rclone stops using the old key. The
	// local sources below stay the fallback for a deployment that swapped a
	// key without handing one back — the restart still comes up, on the key the
	// CLI already had, rather than not at all.
	// Mount.Restart was already required above; a credential with restart
	// false never reaches here.
	if cred := answer.Credential; cred != nil && cred.AccessKeyID != "" && cred.Secret != "" {
		cfg, err := LoadStorageConfig("", "", "", "", "", cred.Secret)
		if err != nil {
			return fmt.Errorf("restart the mount: %w", err)
		}
		cfg.AccessKey = cred.AccessKeyID
		cfg.SessionToken = cred.SessionToken
		// LoadStorageConfig checked the env copies. These two are the
		// server-minted values that actually get written, so they need the
		// same newline/NUL refuse or they inject an rclone option.
		if err := checkConfigValue("access key", cfg.AccessKey); err != nil {
			return fmt.Errorf("restart the mount: %w", err)
		}
		if err := checkConfigValue("session token", cfg.SessionToken); err != nil {
			return fmt.Errorf("restart the mount: %w", err)
		}
		return RestartMount(CurrentGOOS(), home, rcloneBin, cfg)
	}
	// The same secret sources `drive mount` uses, in the same order and never a
	// fourth: the environment, then the config file this CLI wrote 0600. No flag
	// and no prompt, because a restart runs unattended behind a cap swap and a
	// secret in argv is readable in ps for the life of the process (issue #75).
	secretKey, err := ReadSecretKey(RcloneConfigPath(home), false, os.Stdin)
	if err != nil {
		return fmt.Errorf("restart the mount: %w", err)
	}
	cfg, err := LoadStorageConfig("", "", "", "", "", secretKey)
	if err != nil {
		return fmt.Errorf("restart the mount: %w", err)
	}
	return RestartMount(CurrentGOOS(), home, rcloneBin, cfg)
}
