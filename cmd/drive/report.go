package main

import (
	"context"
	"fmt"
	"time"
)

// QueueReport is the live upload queue one device reports (drive issue #318).
type QueueReport struct {
	Files         int   `json:"files"`
	UploadedBytes int64 `json:"uploadedBytes"`
	TotalBytes    int64 `json:"totalBytes"`
	Paused        bool  `json:"paused"`
}

const queueReportInterval = 10 * time.Second

const queueReportHeartbeat = 5 * time.Minute

const queueReportTimeout = 5 * time.Second

// RunQueueReportLoop is the live upload-queue reporter, running inside the mount process for as long as the mount does.
func RunQueueReportLoop(ctx context.Context, c *rcClient, home string) <-chan error {
	errs := make(chan error, 1)
	go func() {
		defer close(errs)
		creds, err := LoadCredentials(home)
		if err != nil {
			select {
			case errs <- fmt.Errorf("queue report: load credentials: %w", err):
			default:
			}
			return
		}
		if creds.DeviceToken == "" || creds.APIBase == "" {
			return
		}
		client, err := NewAPIClient(creds.APIBase, creds.DeviceToken)
		if err != nil {
			select {
			case errs <- fmt.Errorf("queue report: api client: %w", err):
			default:
			}
			return
		}
		ticker := time.NewTicker(queueReportInterval)
		defer ticker.Stop()
		var last QueueReport
		var lastSent time.Time
		haveLast := false
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
			}
			passCtx, cancel := context.WithTimeout(ctx, queueReportTimeout)
			err := reportQueueOnce(passCtx, c, client, home, &last, &lastSent, &haveLast)
			cancel()
			if err != nil {
				select {
				case errs <- fmt.Errorf("queue report: %w", err):
				default:
				}
			}
		}
	}()
	return errs
}

func reportQueueOnce(ctx context.Context, c *rcClient, client *APIClient, home string, last *QueueReport, lastSent *time.Time, haveLast *bool) error {
	queue, err := c.ReadQueue(ctx)
	if err != nil {
		return fmt.Errorf("read queue: %w", err)
	}
	stats, err := c.ReadStats(ctx)
	if err != nil {
		return fmt.Errorf("read stats: %w", err)
	}
	paused := uploadsPaused(ctx, c, home)
	if paused {
		if err := c.HoldQueuedUploads(ctx); err != nil {
			return fmt.Errorf("hold paused uploads: %w", err)
		}
	}
	report := queueReportFrom(queue, stats, paused)
	if !queueReportDue(last, *lastSent, time.Now(), report, *haveLast) {
		return nil
	}
	var answer map[string]any
	if err := client.Post(queueReportPath, report, &answer); err != nil {
		return err
	}
	*last = report
	*lastSent = time.Now()
	*haveLast = true
	return nil
}

func queueReportDue(last *QueueReport, lastSent, now time.Time, next QueueReport, haveLast bool) bool {
	if !haveLast {
		return true
	}
	if *last != next {
		return true
	}
	return now.Sub(lastSent) >= queueReportHeartbeat
}

func uploadsPaused(ctx context.Context, c *rcClient, home string) bool {
	if limit, err := c.BwLimit(ctx); err == nil {
		return rateIsPaused(limit.Rate)
	}
	return Paused(home)
}

func queueReportFrom(q Queue, s Stats, paused bool) QueueReport {
	inFlight := map[string]Transfer{}
	for _, t := range s.Transferring {
		inFlight[t.Name] = t
	}
	var uploaded, total int64
	for _, item := range q.Queue {
		total += item.Size
		if t, ok := inFlight[item.Name]; ok {
			uploaded += t.Bytes
		}
	}
	if uploaded > total {
		uploaded = total
	}
	return QueueReport{
		Files:         len(q.Queue),
		UploadedBytes: uploaded,
		TotalBytes:    total,
		Paused:        paused,
	}
}
