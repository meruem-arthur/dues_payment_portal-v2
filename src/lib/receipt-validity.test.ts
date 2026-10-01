import { describe, it, expect } from "vitest";
import { isReceiptValid } from "./receipt-validity";

const clearance = (over: object = {}) => ({
  kind: "CLEARANCE" as const,
  voidedAt: null,
  payment: null,
  student: { isExempt: true },
  ...over,
});

describe("isReceiptValid (verify page rule)", () => {
  it("is invalid when no receipt exists", () => {
    expect(isReceiptValid(null)).toBe(false);
  });

  it("accepts a payment receipt whose payment succeeded", () => {
    expect(isReceiptValid({ kind: "PAYMENT", voidedAt: null, payment: { status: "SUCCESS" }, student: { isExempt: false } })).toBe(true);
  });

  it("rejects a payment receipt whose payment is not SUCCESS", () => {
    expect(isReceiptValid({ kind: "PAYMENT", voidedAt: null, payment: { status: "REFUNDED" }, student: { isExempt: false } })).toBe(false);
  });

  it("accepts an active clearance receipt with no payment", () => {
    expect(isReceiptValid(clearance())).toBe(true);
  });

  it("rejects a voided clearance receipt", () => {
    expect(isReceiptValid(clearance({ voidedAt: new Date() }))).toBe(false);
  });

  it("rejects a clearance receipt when the student is no longer exempt", () => {
    expect(isReceiptValid(clearance({ student: { isExempt: false } }))).toBe(false);
  });
});
