import { usd } from "./emails-fields.js";

export const SAVED_COPY = Object.freeze({
  capped: "Our price cap saved you",
  uncapped: "You paid",
  uncappedSuffix: "less than a flat plan",
});

/**
 * The "you saved" line for a receipt, or null when there is nothing to say.
 * Capped month: saving = metered - bill. Uncapped month: saving = ceiling -
 * bill. drive#39 fixed both baselines; the caller passes the three numbers it
 * already has, so this stays a pure comparison rather than a second bill.
 * @param {unknown} month
 * @returns {string | null}
 */
export function savedLine(month) {
  if (typeof month !== "object" || month === null) {
    throw new TypeError(`savedLine needs a month object, got ${String(month)}`);
  }
  const fields =
    /** @type {{meteredUsd?: unknown, billUsd?: unknown, ceilingUsd?: unknown, capped?: unknown}} */ (
      month
    );
  const { meteredUsd, billUsd, ceilingUsd, capped } = fields;
  if (typeof capped !== "boolean") {
    throw new TypeError(`capped must be true or false, got ${String(capped)}`);
  }
  if (typeof meteredUsd !== "number" || !Number.isFinite(meteredUsd) || meteredUsd < 0) {
    throw new TypeError(`meteredUsd must be 0 or more, got ${meteredUsd}`);
  }
  if (typeof billUsd !== "number" || !Number.isFinite(billUsd) || billUsd < 0) {
    throw new TypeError(`billUsd must be 0 or more, got ${billUsd}`);
  }
  if (typeof ceilingUsd !== "number" || !Number.isFinite(ceilingUsd) || ceilingUsd < 0) {
    throw new TypeError(`ceilingUsd must be 0 or more, got ${ceilingUsd}`);
  }
  const saved = capped ? meteredUsd - billUsd : ceilingUsd - billUsd;
  if (saved <= 0) {
    return null;
  }
  const dollars = usd(saved);
  return capped
    ? `${SAVED_COPY.capped} ${dollars}`
    : `${SAVED_COPY.uncapped} ${dollars} ${SAVED_COPY.uncappedSuffix}`;
}
