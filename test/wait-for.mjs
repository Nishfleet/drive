// Waiting on the real condition instead of sleeping a fixed time (drive#1166).
//
// Every helper here names what it is waiting for and checks it on a short
// tick, so a fast machine returns on the first check and a slow one still has
// a deadline. The tick only paces the check; the wait itself is on the
// condition, which is also what the deadline is for.

import { once } from "node:events";

/**
 * @template T
 * @param {() => T | Promise<T>} probe truthy when the wait is over
 * @param {number} [timeoutMs]
 * @param {string} [what]
 * @param {() => string} [detail] what to add to the timeout message
 * @returns {Promise<NonNullable<T>>}
 */
export async function waitUntil(probe, timeoutMs = 30_000, what = "the condition", detail) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value) {
      return value;
    }
    if (Date.now() >= deadline) {
      const extra = detail ? `\n${detail()}` : "";
      throw new Error(`timed out after ${timeoutMs}ms waiting for ${what}${extra}`);
    }
    await tick(100);
  }
}

/**
 * Wait for a child process to exit, on its own `exit` event with the deadline
 * as the timeout. Returns false when the deadline passed first, so a caller
 * that escalates to SIGKILL keeps its shape.
 * @param {import("node:child_process").ChildProcess} child
 * @param {number} timeoutMs
 * @returns {Promise<boolean>}
 */
export async function waitForExit(child, timeoutMs) {
  if (child.exitCode !== null) {
    return true;
  }
  try {
    await once(child, "exit", { signal: AbortSignal.timeout(timeoutMs) });
    return true;
  } catch (error) {
    const name = /** @type {{name?: string}} */ (error).name;
    if (name === "AbortError" || name === "TimeoutError") {
      return false;
    }
    throw error;
  }
}

/**
 * @param {number} ms
 * @returns {Promise<void>}
 */
function tick(ms) {
  return new Promise((resolve) => {
    const timer = setInterval(() => {
      clearInterval(timer);
      resolve();
    }, ms);
  });
}
