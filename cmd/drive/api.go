package main

import (
	"fmt"
	"runtime"
	"strings"

	"github.com/Nishfleet/drive/internal/api"
)

// userAgent is what every drive request to the api names itself with:
// drive/<version> (<os>/<arch>). The api Worker reads the version out
// of it and answers 426 with the update sentence when the version is
// below the deployment's configured minimum (drive#560), so an api
// shape change under an old CLI names the fix instead of surfacing as
// an unreadable answer. Go's own default ("Go-http-client/1.1")
// carries no version, which is why the header is set by hand on every
// request this client sends.
func userAgent() string {
	return fmt.Sprintf("drive/%s (%s/%s)", versionText(), runtime.GOOS, runtime.GOARCH)
}

func init() { api.SetUserAgent(userAgent) }

// resolveAPIBase is --api / DRIVE_API_URL, then the apiBase `drive login`
// wrote, then the live site when this device already holds a token. Empty
// means this machine has not signed in and the caller did not pass an address.
func resolveAPIBase(home, explicit string) (string, error) {
	if v := strings.TrimSpace(explicit); v != "" {
		return v, nil
	}
	creds, err := LoadCredentials(home)
	if err != nil {
		return "", err
	}
	if v := strings.TrimSpace(creds.APIBase); v != "" {
		return v, nil
	}
	if strings.TrimSpace(creds.DeviceToken) != "" {
		return defaultAPIBase, nil
	}
	return "", nil
}

// accountLabel is the words `drive login` prints after "Signed in as": the
// email a person recognises, never the account id.
func accountLabel(account Account) string {
	if e := strings.TrimSpace(account.Email); e != "" {
		return e
	}
	if n := strings.TrimSpace(account.Name); n != "" && n != account.ID {
		return n
	}
	return ""
}
