import { createHmac, timingSafeEqual } from "crypto";

/**
 * Short-lived, signed token that lets a "Dues Cleared" student download
 * their clearance receipt from the public payment flow.
 *
 * Why a token instead of a URL keyed by receipt number: receipt numbers are
 * sequential (CLR-2026-000001, ...), so a permanent public download URL
 * keyed by one could be enumerated. This token is only ever handed out by
 * /api/students/lookup after the caller supplied a valid reference number,
 * and it expires after ~15 minutes.
 *
 * Format: base64url(payload JSON) + "." + base64url(HMAC-SHA256(payload)),
 * signed with AUTH_SECRET. Stateless - nothing is stored server-side.
 */

export const CLEARANCE_TOKEN_TTL_MS = 15 * 60 * 1000;

type TokenPayload = { sid: string; exp: number };

export type ClearanceTokenResult =
  | { valid: true; studentId: string }
  | { valid: false; reason: "malformed" | "bad-signature" | "expired" };

function getSecret(): string {
  const secret = process.env.AUTH_SECRET;
  if (!secret) throw new Error("AUTH_SECRET is not set - cannot sign clearance receipt tokens");
  return secret;
}

function sign(encodedPayload: string): Buffer {
  return createHmac("sha256", getSecret()).update(encodedPayload).digest();
}

export function createClearanceToken(studentId: string, now: number = Date.now()): string {
  const payload: TokenPayload = { sid: studentId, exp: now + CLEARANCE_TOKEN_TTL_MS };
  const encodedPayload = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${encodedPayload}.${sign(encodedPayload).toString("base64url")}`;
}

export function verifyClearanceToken(token: string, now: number = Date.now()): ClearanceTokenResult {
  const parts = token.split(".");
  if (parts.length !== 2 || !parts[0] || !parts[1]) return { valid: false, reason: "malformed" };
  const [encodedPayload, encodedSignature] = parts;

  const expected = sign(encodedPayload);
  const provided = Buffer.from(encodedSignature, "base64url");
  // timingSafeEqual throws on length mismatch, so compare lengths first.
  if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) {
    return { valid: false, reason: "bad-signature" };
  }

  let payload: TokenPayload;
  try {
    payload = JSON.parse(Buffer.from(encodedPayload, "base64url").toString("utf8"));
  } catch {
    return { valid: false, reason: "malformed" };
  }
  if (typeof payload?.sid !== "string" || typeof payload?.exp !== "number") {
    return { valid: false, reason: "malformed" };
  }
  if (payload.exp <= now) return { valid: false, reason: "expired" };

  return { valid: true, studentId: payload.sid };
}
