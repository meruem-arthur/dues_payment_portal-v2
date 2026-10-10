import { describe, it, expect } from "vitest";
import { pickPaymentConfig } from "./resolve-config";

const legacy = { provider: "PAYSTACK", secretKey: "sk_legacy", configValue: "ACCT_legacy" };
const fresher = { paymentType: "FRESHER", provider: "PAYSTACK", secretKey: "sk_fresher", configValue: "ACCT_fresher" };
const continuing = { paymentType: "CONTINUING", provider: "PAYSTACK", secretKey: "sk_cont", configValue: "ACCT_cont" };

describe("pickPaymentConfig", () => {
  it("returns the row for the payment's own student type", () => {
    const department = { paymentConfig: legacy, paymentTypeConfigs: [fresher, continuing] };

    expect(pickPaymentConfig(department, "FRESHER")).toBe(fresher);
    expect(pickPaymentConfig(department, "CONTINUING")).toBe(continuing);
  });

  it("does not depend on the order the rows come back in", () => {
    const department = { paymentConfig: legacy, paymentTypeConfigs: [continuing, fresher] };

    expect(pickPaymentConfig(department, "FRESHER")).toBe(fresher);
    expect(pickPaymentConfig(department, "CONTINUING")).toBe(continuing);
  });

  it("falls back to the department's original config when that type has no row", () => {
    const department = { paymentConfig: legacy, paymentTypeConfigs: [fresher] };

    expect(pickPaymentConfig(department, "FRESHER")).toBe(fresher);
    // Only freshers were split out - continuing students keep the original.
    expect(pickPaymentConfig(department, "CONTINUING")).toBe(legacy);
  });

  it("falls back to the original config when there are no type rows at all", () => {
    expect(pickPaymentConfig({ paymentConfig: legacy, paymentTypeConfigs: [] }, "FRESHER")).toBe(legacy);
    expect(pickPaymentConfig({ paymentConfig: legacy, paymentTypeConfigs: null }, "CONTINUING")).toBe(legacy);
    expect(pickPaymentConfig({ paymentConfig: legacy }, "FRESHER")).toBe(legacy);
  });

  it("returns null when the department has no payment configuration of any kind", () => {
    expect(pickPaymentConfig({ paymentConfig: null, paymentTypeConfigs: [] }, "FRESHER")).toBeNull();
    expect(pickPaymentConfig({}, "CONTINUING")).toBeNull();
  });

  it("uses a type row even when the original config is missing", () => {
    expect(pickPaymentConfig({ paymentConfig: null, paymentTypeConfigs: [continuing] }, "CONTINUING")).toBe(continuing);
  });
});
