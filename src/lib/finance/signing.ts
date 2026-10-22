import crypto from "crypto";

/**
 * Signing helpers shared by the push webhook and the sign-in handoff.
 *
 * Both use HMAC-SHA256 with the same FINANCE_PUSH_TOKEN, but each signs a
 * differently-prefixed message ("push." / "sso.") so a signature produced for
 * one purpose can never be replayed as the other.
 */

export function timingSafeEqualStrings(a: string, b: string): boolean {
  const ha = crypto.createHash("sha256").update(a).digest();
  const hb = crypto.createHash("sha256").update(b).digest();
  return crypto.timingSafeEqual(ha, hb);
}

// ---- push webhook (dues -> finance) ----------------------------------

export function signPush(body: string, timestampSeconds: number, token: string): string {
  return crypto.createHmac("sha256", token).update(`push.${timestampSeconds}.${body}`).digest("hex");
}

export function verifyPush(
  body: string,
  timestampSeconds: number,
  signature: string,
  token: string,
  nowSeconds = Math.floor(Date.now() / 1000),
  toleranceSeconds = 300
): boolean {
  if (!Number.isFinite(timestampSeconds)) return false;
  if (Math.abs(nowSeconds - timestampSeconds) > toleranceSeconds) return false;
  return timingSafeEqualStrings(signPush(body, timestampSeconds, token), signature);
}

// ---- sign-in handoff token (dues -> browser -> finance) ---------------

export type SsoClaims = {
  iss: "dues";
  aud: "finance";
  sub: string; // dues user id
  name: string;
  email: string;
  role: "SUPER_ADMIN" | "DEPARTMENT_ADMIN";
  departmentCode: string;
  iat: number; // seconds
  exp: number; // seconds
  jti: string; // single-use id
};

export const SSO_TOKEN_TTL_SECONDS = 60;

function b64url(buf: Buffer): string {
  return buf.toString("base64url");
}

function ssoSignature(payloadB64: string, token: string): string {
  return b64url(crypto.createHmac("sha256", token).update(`sso.${payloadB64}`).digest());
}

export function createSsoToken(
  input: Omit<SsoClaims, "iss" | "aud" | "iat" | "exp" | "jti">,
  token: string,
  nowSeconds = Math.floor(Date.now() / 1000)
): string {
  const claims: SsoClaims = {
    ...input,
    iss: "dues",
    aud: "finance",
    iat: nowSeconds,
    exp: nowSeconds + SSO_TOKEN_TTL_SECONDS,
    jti: crypto.randomUUID(),
  };
  const payloadB64 = b64url(Buffer.from(JSON.stringify(claims), "utf8"));
  return `${payloadB64}.${ssoSignature(payloadB64, token)}`;
}

export function verifySsoToken(
  value: string,
  token: string,
  nowSeconds = Math.floor(Date.now() / 1000)
): SsoClaims | null {
  const parts = value.split(".");
  if (parts.length !== 2) return null;
  const [payloadB64, sig] = parts;
  if (!timingSafeEqualStrings(ssoSignature(payloadB64, token), sig)) return null;
  try {
    const claims = JSON.parse(Buffer.from(payloadB64, "base64url").toString("utf8")) as SsoClaims;
    if (claims.iss !== "dues" || claims.aud !== "finance") return null;
    if (typeof claims.exp !== "number" || claims.exp < nowSeconds) return null;
    return claims;
  } catch {
    return null;
  }
}
