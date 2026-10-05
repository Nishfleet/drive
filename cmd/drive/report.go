package main

import (
	"context"
	"fmt"
	"time"
)

// QueueReport is the live upload queue one device reports (drive issue #318).
// The field names are the JSON body POST /v1/queue reads, and the byte pair is
// the same arithmetic the page's uploadLine() does: bytes already up of the
// bytes there are to send.
type QueueReport struct {
	Files         int   `json:"files"`
	UploadedBytes int64 `json:"uploadedBytes"`
	TotalBytes    int64 `json:"totalBytes"`
	Paused        bool  `json:"paused"`
}

// queueReportPath is the api Worker's queue-report endpoint.
const queueReportPath = "/v1/queue"

// queueReportInterval is how often the mount's reporter ticks. It is the same
// number the server enforces as the minimum spacing between two accepted
// reports (workers/api/src/queues.js QUEUE_REPORT_INTERVAL_SECONDS). Ten
// seconds is far above the queue's own change rate and far below a keyboard's.
const queueReportInterval = 10 * time.Second

// queueReportHeartbeat is the longest a mount may stay silent when the queue
// has not changed. Together with "send on change", this is about 12 writes a
// day at idle instead of one every 10 seconds.
const queueReportHeartbeat = 5 * time.Minute

// queueReportTimeout bounds one HTTP call so a slow Worker does not hold the
// reporter loop.
const queueReportTimeout = 5 * time.Second

// RunQueueReportLoop is the live upload-queue reporter, running inside the
// mount process for as long as the mount does. It is started by
// mountForeground and stopped with the mount; it is not a second daemon and
// not a script. It reads the same numbers `drive pause` and `drive status`
// already read (cmd/drive/rc.go, cmd/drive/status.go): rclone's vfs/queue,
// core/stats, and core/bwlimit, transported over the device token the sign-in
// flow already minted. Every error is reported on the returned error channel
// with a named cause, and the loop continues: one bad pass must not take the
// mount down, and it must not be silent either.
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
			// Not signed in: nothing to report to. A device that has not signed
			// in yet has no account to report a queue for, so this loop ends
			// without error — the mount keeps running, and the report just
			// does not fire.
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

// reportQueueOnce reads the mount's queue and stats and posts the report.
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
	if err := client.post(queueReportPath, report, &answer); err != nil {
		return err
	}
	*last = report
	*lastSent = time.Now()
	*haveLast = true
	return nil
}

// queueReportDue is whether this pass should POST: the first report, a
// changed queue, or the 5-minute heartbeat.
func queueReportDue(last *QueueReport, lastSent, now time.Time, next QueueReport, haveLast bool) bool {
	if !haveLast {
		return true
	}
	if *last != next {
		return true
	}
	return now.Sub(lastSent) >= queueReportHeartbeat
}

// uploadsPaused answers whether uploads are stopped right now: the same
// question `drive status` prints on its transfers line, answered as the
// boolean the queue report carries. Rclone's own rate in force is the answer
// when the mount answers the remote control, and the pause marker is the
// answer when it does not, so a drive paused while unmounted still reports
// paused rather than running.
func uploadsPaused(ctx context.Context, c *rcClient, home string) bool {
	if limit, err := c.BwLimit(ctx); err == nil {
		return rateIsPaused(limit.Rate)
	}
	return Paused(home)
}

// queueReportFrom builds the report body from rclone's two answers and the
// paused boolean. uploadedBytes is the bytes already up among the files in the
// queue (core/stats' transferring.Bytes for names that are also in vfs/queue).
// totalBytes is the sum of the queue's sizes. files is the queue length.
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
