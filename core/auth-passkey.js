import { passkey } from "@better-auth/passkey";
import { createAuth } from "./auth.js";

/**
 * The same Better Auth instance createAuth builds, with the passkey plugin
 * on it. Registration, list and sign-in options live on this instance; every
 * other path keeps using createAuth so the passkey stack stays out of the
 * isolate script.
 *
 * @param {{database: unknown, secret: string, baseURL: string, sendLink: (link: {to: string, url: string, userAgent: string|null, deviceApproval?: boolean}) => Promise<unknown>}} options
 */
export function createAuthWithPasskey(options) {
  return createAuth({
    ...options,
    plugins: [
      passkey({
        rpID: new URL(options.baseURL).hostname,
        rpName: "drive",
        origin: new URL(options.baseURL).origin,
      }),
    ],
  });
}
