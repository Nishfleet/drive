package api

import (
	"fmt"
	"io"
	"time"
)

// OpenURL opens the device-approve page.
var OpenURL = func(raw string) error { return nil }

// SignedIn is what one device flow ends with: the token, the epoch second its window ends at, and the account it names.
type SignedIn struct {
	Token     string
	ExpiresAt int64
	Account   Account
}

// SignIn runs the device flow on the terminal: ask for a code, print it and the page to approve it on, then poll until the person approves or the code expires.
func SignIn(client *Client, deviceName string, out io.Writer) (SignedIn, error) {
	code, err := client.RequestDeviceCode(deviceName)
	if err != nil {
		return SignedIn{}, err
	}
	page := code.VerificationURIComplete
	if page == "" {
		page = code.VerificationURI
	}
	fmt.Fprintf(out, "Approve this device in the browser:\n  %s\n  code: %s\n",
		page, code.UserCode)
	if err := OpenURL(page); err != nil {
		fmt.Fprintln(out, "Could not open the browser. Open that page.")
	}
	fmt.Fprintln(out, "Waiting for approval.")

	interval := time.Duration(code.Interval) * time.Second
	if interval < time.Second {
		interval = 5 * time.Second
	}
	deadline := time.Duration(code.ExpiresIn) * time.Second
	if deadline <= 0 {
		deadline = 10 * time.Minute
	}
	wait := time.NewTicker(interval)
	defer wait.Stop()
	timeout := time.After(deadline)
	for {
		select {
		case <-timeout:
			return SignedIn{}, wrapFail("sign-in-expired", nil)
		case <-wait.C:
		}
		result, err := client.pollToken(code.DeviceCode)
		if err != nil {
			return SignedIn{}, err
		}
		switch result.Status {
		case "approved":
			if result.DeviceToken == "" || result.Account == nil {
				return SignedIn{}, wrapFail("api-answer", nil)
			}
			return SignedIn{Token: result.DeviceToken, ExpiresAt: result.ExpiresAt, Account: *result.Account}, nil
		case "pending":
			fmt.Fprint(out, ".")
			continue
		default:
			return SignedIn{}, wrapFail("api-answer", fmt.Errorf("the api Worker answered %q to the device poll", result.Status))
		}
	}
}
