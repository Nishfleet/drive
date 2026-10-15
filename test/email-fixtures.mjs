import { replyToFor } from "../core/email-send.js";

export const MAIL_FROM = "notifications@drive.example";
export const REPLY_TO = replyToFor(MAIL_FROM);

/** @param {Record<string, unknown>} [overrides] */
export function receiptData(overrides = {}) {
  return {
    monthIso: "2026-10-01T00:00:00.000Z",
    billUsd: 12,
    meteredUsd: 16,
    ceilingUsd: 12,
    capped: true,
    replyTo: REPLY_TO,
    ...overrides,
  };
}

/** @param {string} kind */
export function dataFor(kind) {
  const base = { replyTo: REPLY_TO };
  switch (kind) {
    case "welcome":
      return { ...base };
    case "cap-warning":
      return { ...base, capUsd: 12 };
    case "read-only":
      return { ...base, capUsd: 12 };
    case "payment-failed":
      return { ...base, amountUsd: 23.5 };
    case "monthly-receipt":
      return { ...receiptData(), ...base };
    case "account-closed":
    case "account-close-reminder":
      return { ...base, graceDays: 30, reminderDays: 25, purgeOn: "3 Nov (UTC)" };
    case "files-deleted":
      return { ...base, purgedOn: "3 Nov (UTC)", graceDays: 30 };
    case "top-up-receipt":
      return { ...base, amountUsd: 25, balanceUsd: 31.5, auto: false };
    case "low-balance":
      return { ...base, balanceUsd: 1.8, autoTopUpUsd: null };
    case "fair-use-pause":
      return {
        ...base,
        copy: "No upload room left. Uploads pause because young deletes still count until 5 Nov 2026. Uploads open again on 5 Nov 2026.",
      };
    case "device-approve-notice":
      return {
        ...base,
        deviceName: "office laptop",
        requestedAt: "2026-10-05T12:00:00.000Z",
      };
    case "upload-arrivals":
      return {
        ...base,
        ownerName: "Nish",
        folder: "Your drive",
        arrivals: [{ name: "contract.pdf", sizeLabel: "1.2 MB" }],
      };
    case "security-event":
      return {
        ...base,
        event: "agent-key-minted",
        deviceName: "office laptop",
        happenedAt: "2026-10-06T09:00:00.000Z",
      };
    case "monthly-story":
      return {
        ...base,
        monthIso: "2026-09-01T00:00:00.000Z",
        peakLine: "Your drive peaked at 40 GB.",
        filesAdded: 12,
        spentLine: "It cost $0.80.",
      };
    case "first-file-nudge":
      return { ...base, hours: 24 };
    case "bill-dropped":
      return { ...base, fromLine: "$10.00", toLine: "$2.00" };
    case "runway-notice":
      return { ...base, runwayLine: "Your $14 lasts about 1 month at your current size." };
    default:
      throw new Error(`no test data for ${kind}`);
  }
}
