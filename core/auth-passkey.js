// Passkey-enabled Better Auth instance (drive issue #846).
//
// The main Worker entry builds auth without this plugin, so the ~590 KB
// WebAuthn stack (@simplewebauthn/server, @peculiar/x509, asn1js and the rest)
// is not parsed on every request. This module is loaded only when a passkey
// route arrives (`await import` from authForPasskey in core/auth.js). The
// factory is createAuth plus the stock passkey plugin, not a second copy of
// the sign-in chain.
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
