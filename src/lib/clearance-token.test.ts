import { describe, it, expect, beforeEach } from "vitest";
import { createClearanceToken, verifyClearanceToken, CLEARANCE_TOKEN_TTL_MS } from "./clearance-token";

beforeEach(() => {
  process.env.AUTH_SECRET = "test-secret-for-clearance-tokens";
});

describe("clearance token", () => {
  it("round-trips a valid token", () => {
    const token = createClearanceToken("student_1");
    expect(verifyClearanceToken(token)).toEqual({ valid: true, studentId: "student_1" });
  });

  it("lasts about 15 minutes and then expires", () => {
    const now = 1_000_000;
    const token = createClearanceToken("student_1", now);
    expect(verifyClearanceToken(token, now + CLEARANCE_TOKEN_TTL_MS - 1).valid).toBe(true);
    expect(verifyClearanceToken(token, now + CLEARANCE_TOKEN_TTL_MS)).toEqual({ valid: false, reason: "expired" });
  });

  it("rejects a tampered payload (swapping in another student id)", () => {
    const token = createClearanceToken("student_1");
    const [, sig] = token.split(".");
    const forgedPayload = Buffer.from(JSON.stringify({ sid: "student_2", exp: Date.now() + 60_000 })).toString("base64url");
    expect(verifyClearanceToken(`${forgedPayload}.${sig}`)).toEqual({ valid: false, reason: "bad-signature" });
  });

  it("rejects a tampered signature", () => {
    const token = createClearanceToken("student_1");
    expect(verifyClearanceToken(token.slice(0, -2) + "xx").valid).toBe(false);
  });

  it("rejects a token signed with a different secret", () => {
    const token = createClearanceToken("student_1");
    process.env.AUTH_SECRET = "a-different-secret";
    expect(verifyClearanceToken(token)).toEqual({ valid: false, reason: "bad-signature" });
  });

  it("rejects malformed input", () => {
    expect(verifyClearanceToken("")).toEqual({ valid: false, reason: "malformed" });
    expect(verifyClearanceToken("nodots")).toEqual({ valid: false, reason: "malformed" });
    expect(verifyClearanceToken("a.b.c")).toEqual({ valid: false, reason: "malformed" });
  });

  it("refuses to sign when AUTH_SECRET is missing", () => {
    delete process.env.AUTH_SECRET;
    expect(() => createClearanceToken("student_1")).toThrow(/AUTH_SECRET/);
  });
});
