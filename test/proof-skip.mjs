import { appendFileSync } from "node:fs";

// The named proofs whose tools this repo's CI runners already carry: Chrome is
// on the hosted ubuntu image the verify job uses, and a container engine is
// there too, so the S3 stand-in can start. A skip of one of these is a failure
// under CI=true, the same shape as skipNoMount's FUSE skip (drive#501), so a
// runner that can run a proof and does not is a red build and not a silence
// (drive#582).
const RUNNABLE_PROOFS = new Set(["chrome-file-click", "s3-standin"]);

/**
 * A named proof skipped. Under CI=true a proof the runner has the tools for
 * fails, because a silent skip is a green build that proved nothing; anywhere
 * else the skip stays honest and quiet, with one line per proof written to
 * DRIVE_PROOF_REPORT when the caller asks for it.
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
