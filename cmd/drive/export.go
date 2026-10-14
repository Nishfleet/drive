package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"net/http"
	"net/url"
	"os"
)

// EXPORT_PATH is the api Worker's own-data export endpoint (workers/api/src/export-routes.js).
const EXPORT_PATH = "/v1/export"

const exportMaxPages = 1000

func exportCursorText(cursor *string) string {
	if cursor == nil {
		return "-"
	}
	return *cursor
}

func exportVersionCursorText(document ExportDocument) string {
	if document.Next.VersionCursor == nil {
		return "-"
	}
	return fmt.Sprintf("%d/%s", document.Next.VersionCursor.At, document.Next.VersionCursor.ID)
}

// ExportDocument is the account's own data as the route returns it: the account row, its keys, the file index and the version history.
type ExportDocument struct {
	GeneratedAt string          `json:"generatedAt"`
	Account     ExportAccount   `json:"account"`
	Keys        []ExportKey     `json:"keys"`
	Files       []ExportFile    `json:"files"`
	Versions    []ExportVersion `json:"versions"`
	Complete    bool            `json:"complete"`
	Next        struct {
		FileCursor    *string              `json:"fileCursor"`
		VersionCursor *ExportVersionCursor `json:"versionCursor"`
	} `json:"next"`
}

// ExportVersionCursor is the position the version page stopped at: the created_at of its last row and that row's b2_file_id, which together break the ties between versions written in the same millisecond.
type ExportVersionCursor struct {
	At int64  `json:"at"`
	ID string `json:"id"`
}

// ExportAccount is the account the export is about.
type ExportAccount struct {
	ID    string `json:"id"`
	Name  string `json:"name"`
	Email string `json:"email"`
}

// ExportKey is one of the account's keys as the export carries it.
type ExportKey struct {
	KeyID        string   `json:"keyId"`
	Name         string   `json:"name"`
	Kind         string   `json:"kind"`
	Prefix       string   `json:"prefix"`
	Capabilities []string `json:"capabilities"`
	CreatedAt    int64    `json:"createdAt"`
	LastSeenAt   *int64   `json:"lastSeenAt"`
	RevokedAt    *int64   `json:"revokedAt"`
}

// ExportFile is one row of the account's file-name index.
type ExportFile struct {
	Path       string  `json:"path"`
	Name       string  `json:"name"`
	Parent     string  `json:"parent"`
	SizeBytes  int64   `json:"sizeBytes"`
	ModifiedAt *string `json:"modifiedAt"`
	IndexedAt  *string `json:"indexedAt"`
}

// ExportVersion is one row of the account's version history, the same file_versions table the meter bills from.
type ExportVersion struct {
	B2FileID  string `json:"b2FileId"`
	Path      string `json:"path"`
	SizeBytes int64  `json:"sizeBytes"`
	CreatedAt int64  `json:"createdAt"`
	HiddenAt  *int64 `json:"hiddenAt"`
	DeletedAt *int64 `json:"deletedAt"`
}

func runExport(args []string) error {
	fs := flag.NewFlagSet("export", flag.ContinueOnError)
	common := addCommonFlags(fs)
	out := fs.String("out", "", "write the export to this file instead of stdout")
	if err := fs.Parse(args); err != nil {
		return errFlagParse
	}
	if fs.NArg() > 0 {
		return fmt.Errorf("unexpected argument %q", fs.Arg(0))
	}
	creds, err := LoadCredentials(common.home)
	if err != nil {
		return err
	}
	base, err := resolveAPIBase(common.home, "")
	if err != nil {
		return err
	}
	if creds.DeviceToken == "" || base == "" {
		return fail("not-signed-in")
	}
	document, err := fetchExport(base, creds.DeviceToken)
	if err != nil {
		return err
	}
	raw, err := json.MarshalIndent(document, "", "  ")
	if err != nil {
		return fmt.Errorf("encode the export: %w", err)
	}
	raw = append(raw, '\n')
	summary := fmt.Sprintf("%d file(s) and %d key(s) for %s",
		len(document.Files), len(document.Keys), exportAccountLabel(document.Account))
	if *out == "" {
		if _, err := os.Stdout.Write(raw); err != nil {
			return fmt.Errorf("write the export to stdout: %w", err)
		}
		fmt.Fprintln(os.Stderr, "exported "+summary)
		return nil
	}
	if err := WriteFileAtomic(*out, raw, 0o600); err != nil {
		return err
	}
	fmt.Printf("wrote %s: %s\n", *out, summary)
	return nil
}

func exportAccountLabel(account ExportAccount) string {
	if account.Email != "" {
		return account.Email
	}
	if account.Name != "" {
		return account.Name
	}
	return account.ID
}

func fetchExport(apiBase, deviceToken string) (*ExportDocument, error) {
	client, err := NewAPIClient(apiBase, deviceToken)
	if err != nil {
		return nil, err
	}
	var document ExportDocument
	if err := client.Do(http.MethodGet, exportPagePath("", nil), nil, &document); err != nil {
		return nil, err
	}
	if document.Account.ID == "" {
		return nil, fmt.Errorf("GET %s%s answered without an account; run `drive init` again",
			client.Base, EXPORT_PATH)
	}
	for pages := 0; !document.Complete; pages++ {
		if pages >= exportMaxPages {
			return nil, fmt.Errorf("the export did not finish within %d pages (%d file(s), %d version(s)); "+
				"the last page ended at file cursor %q, version cursor %s",
				exportMaxPages, len(document.Files), len(document.Versions),
				exportCursorText(document.Next.FileCursor), exportVersionCursorText(document))
		}
		fileCursor := ""
		if document.Next.FileCursor != nil {
			fileCursor = *document.Next.FileCursor
		}
		var page ExportDocument
		if err := client.Do(http.MethodGet, exportPagePath(fileCursor, document.Next.VersionCursor), nil, &page); err != nil {
			return nil, fmt.Errorf("continue the export after %d file(s): %w", len(document.Files), err)
		}
		document.Files = append(document.Files, page.Files...)
		document.Versions = append(document.Versions, page.Versions...)
		document.Complete = page.Complete
		document.Next = page.Next
	}
	return &document, nil
}

func exportPagePath(fileCursor string, versionCursor *ExportVersionCursor) string {
	params := url.Values{}
	if fileCursor != "" {
		params.Set("fileCursor", fileCursor)
	}
	if versionCursor != nil {
		params.Set("versionAt", fmt.Sprintf("%d", versionCursor.At))
		if versionCursor.ID != "" {
			params.Set("versionId", versionCursor.ID)
		}
	}
	if len(params) == 0 {
		return EXPORT_PATH
	}
	return EXPORT_PATH + "?" + params.Encode()
}
