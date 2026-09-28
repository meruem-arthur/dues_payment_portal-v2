import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { PaystackProvider } from "@/lib/payments/paystack.provider";
import { HubtelProvider } from "@/lib/payments/hubtel.provider";

// The reconcile job only marks a payment FAILED when the provider's answer
// maps to state "FAILED". Getting this wrong in the "too eager" direction
// would fail someone's still-in-progress payment, so the mapping is pinned here.

const ids = { providerTxId: "", internalReference: "PAY-GESA-1" };
const paystackCreds = { secretKey: "sk_test", environment: "TEST" as const };
const hubtelCreds = { publicKey: "id", secretKey: "secret", environment: "TEST" as const };

function mockFetchJson(body: unknown, ok = true, status = 200) {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok, status, json: async () => body }));
}

afterEach(() => vi.unstubAllGlobals());
beforeEach(() => vi.clearAllMocks());

describe("PaystackProvider.verifyTransaction state", () => {
  const tx = (status: string) => ({
    data: { id: 123, status, reference: "PAY-GESA-1", amount: 18000, currency: "GHS", paid_at: "2026-09-18T11:19:00Z" },
  });

  it("success -> SUCCESS", async () => {
    mockFetchJson(tx("success"));
    const r = await new PaystackProvider().verifyTransaction(ids, paystackCreds);
    expect(r).toMatchObject({ success: true, state: "SUCCESS", providerTxId: "123", amount: 180 });
  });

  it.each(["failed", "reversed"])("%s -> FAILED", async (status) => {
    mockFetchJson(tx(status));
    const r = await new PaystackProvider().verifyTransaction(ids, paystackCreds);
    expect(r).toMatchObject({ success: false, state: "FAILED" });
  });

  it.each(["abandoned", "ongoing", "pending", "processing", "queued"])(
    "%s -> PENDING (the customer may still complete it, so it must never count as failed)",
    async (status) => {
      mockFetchJson(tx(status));
      const r = await new PaystackProvider().verifyTransaction(ids, paystackCreds);
      expect(r).toMatchObject({ success: false, state: "PENDING" });
    }
  );

  it("throws on a non-2xx response so callers treat it as 'unknown', not 'failed'", async () => {
    mockFetchJson({}, false, 401);
    await expect(new PaystackProvider().verifyTransaction(ids, paystackCreds)).rejects.toThrow(/401/);
  });
});

describe("HubtelProvider.verifyTransaction state", () => {
  const tx = (status: string) => ({ data: { status, transactionId: "hub_1", clientReference: "PAY-GESA-1", amount: 180 } });
  const hubIds = { providerTxId: "hub_1", internalReference: "PAY-GESA-1" };

  it.each(["completed", "success"])("%s -> SUCCESS", async (status) => {
    mockFetchJson(tx(status));
    const r = await new HubtelProvider().verifyTransaction(hubIds, hubtelCreds);
    expect(r).toMatchObject({ success: true, state: "SUCCESS" });
  });

  it("failed -> FAILED", async () => {
    mockFetchJson(tx("failed"));
    const r = await new HubtelProvider().verifyTransaction(hubIds, hubtelCreds);
    expect(r).toMatchObject({ success: false, state: "FAILED" });
  });

  it("any other status -> PENDING", async () => {
    mockFetchJson(tx("processing"));
    const r = await new HubtelProvider().verifyTransaction(hubIds, hubtelCreds);
    expect(r).toMatchObject({ success: false, state: "PENDING" });
  });
});
