import { describe, it, expect } from "vitest";
import { createSsoToken, signPush, verifyPush, verifySsoToken, SSO_TOKEN_TTL_SECONDS } from "./signing";

const TOKEN = "test-shared-token";
const now = 1_800_000_000;

describe("push signing", () => {
  const body = JSON.stringify({ event: "payment.updated" });

  it("verifies a correctly signed, fresh push", () => {
    const sig = signPush(body, now, TOKEN);
    expect(verifyPush(body, now, sig, TOKEN, now + 10)).toBe(true);
  });

  it("rejects a tampered body, wrong token, and stale timestamp", () => {
    const sig = signPush(body, now, TOKEN);
    expect(verifyPush(body + " ", now, sig, TOKEN, now)).toBe(false);
    expect(verifyPush(body, now, sig, "other-token", now)).toBe(false);
    expect(verifyPush(body, now, sig, TOKEN, now + 301)).toBe(false);
  });
});

describe("sso token", () => {
  const input = { sub: "u1", name: "Ama", email: "ama@x.com", role: "DEPARTMENT_ADMIN" as const, departmentCode: "GESA" };

  it("round-trips valid claims with a short expiry", () => {
    const claims = verifySsoToken(createSsoToken(input, TOKEN, now), TOKEN, now + 5);
    expect(claims?.sub).toBe("u1");
    expect(claims?.exp).toBe(now + SSO_TOKEN_TTL_SECONDS);
    expect(claims?.jti).toBeTruthy();
  });

  it("rejects expired, tampered and wrong-secret tokens", () => {
    const t = createSsoToken(input, TOKEN, now);
    expect(verifySsoToken(t, TOKEN, now + SSO_TOKEN_TTL_SECONDS + 1)).toBeNull();
    expect(verifySsoToken(t, "other-token", now)).toBeNull();
    const [payload, sig] = t.split(".");
    const forged = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(payload, "base64url").toString()), role: "SUPER_ADMIN" })).toString("base64url");
    expect(verifySsoToken(`${forged}.${sig}`, TOKEN, now)).toBeNull();
  });

  it("a push signature can never be replayed as a sso token", () => {
    const payload = Buffer.from(JSON.stringify({ iss: "dues", aud: "finance", exp: now + 60 })).toString("base64url");
    const pushSig = signPush(payload, now, TOKEN);
    expect(verifySsoToken(`${payload}.${pushSig}`, TOKEN, now)).toBeNull();
  });
});
