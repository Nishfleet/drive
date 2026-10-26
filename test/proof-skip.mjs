import { appendFileSync } from "node:fs";

const RUNNABLE_PROOFS = new Set(["chrome-file-click", "s3-standin", "cap-mount-rclone"]);

/**
 * @param {string} name
 * @param {string} reason
 */
export function reportSkip(name, reason) {
  if (process.env.CI === "true" && RUNNABLE_PROOFS.has(name)) {
    throw new Error(`${name} skipped under CI=true: ${reason}`);
  }
  const report = process.env.DRIVE_PROOF_REPORT;
  if (report) appendFileSync(report, `${name}: ${reason}\n`);
}
