package httpclient

import (
	"net/http"
	"time"
)

// New returns the one HTTP client constructor this CLI uses: a client
// bounded by timeout, so a Worker or page that never answers fails with
// a sentence rather than hanging the terminal.
func New(timeout time.Duration) *http.Client {
	return &http.Client{Timeout: timeout}
}
