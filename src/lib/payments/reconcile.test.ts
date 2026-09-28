import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/db", () => ({
  prisma: {
    payment: { findUnique: vi.fn(), findMany: vi.fn(), updateMany: vi.fn() },
  },
}));
vi.mock("@/lib/audit", () => ({ logAudit: vi.fn() }));
vi.mock("@/lib/monitoring/capture-error", () => ({ captureError: vi.fn() }));
vi.mock("@/lib/crypto/field-encryption", () => ({
  // Identity: encryption itself is covered in field-encryption.test.ts.
  decryptPaymentSecrets: vi.fn((c: unknown) => c),
}));
vi.mock("@/lib/payments/provider-factory", () => ({ getPaymentProvider: vi.fn() }));
vi.mock("@/lib/payments/confirm-payment", () => ({ confirmSuccessfulPayment: vi.fn() }));

import { prisma } from "@/lib/db";
import { logAudit } from "@/lib/audit";
import { getPaymentProvider } from "@/lib/payments/provider-factory";
import { confirmSuccessfulPayment } from "@/lib/payments/confirm-payment";
import { reconcilePayment, reconcileStalePayments } from "@/lib/payments/reconcile";

const mockedPrisma = vi.mocked(prisma, true);
const mockedGetProvider = vi.mocked(getPaymentProvider);
const mockedConfirm = vi.mocked(confirmSuccessfulPayment);
const mockedAudit = vi.mocked(logAudit);

const config = (provider: "PAYSTACK" | "HUBTEL" = "PAYSTACK") => ({
  provider,
  publicKey: "pk",
  secretKey: "sk",
  webhookSecret: "wh",
  configValue: "ACCT_x",
  environment: "TEST",
});

const pendingPayment = (over: Record<string, unknown> = {}) => ({
  id: "payment_1",
  departmentId: "dept_1",
  status: "PENDING",
  internalReference: "PAY-GESA-1",
  providerTxId: null,
  paidAt: null,
  receipt: null,
  department: { paymentConfig: config() },
  ...over,
});

let verifyTransaction: ReturnType<typeof vi.fn>;
const opts = { source: "admin" as const, actorUserId: "user_1" };

beforeEach(() => {
  vi.clearAllMocks();
  mockedPrisma.payment.findUnique.mockResolvedValue(pendingPayment() as any);
  mockedPrisma.payment.updateMany.mockResolvedValue({ count: 1 } as any);
  mockedConfirm.mockResolvedValue({ newlyConfirmed: true, receiptNumber: "REC-2026-000009", receiptCreated: true });

  verifyTransaction = vi.fn().mockResolvedValue({
    success: true,
    state: "SUCCESS",
    providerTxId: "tx_99",
    internalReference: "PAY-GESA-1",
    amount: 180,
    currency: "GHS",
    paidAt: new Date("2026-09-18T11:19:00Z"),
    raw: {},
  });
  mockedGetProvider.mockReturnValue({ verifyTransaction } as any);
});

describe("reconcilePayment", () => {
  it("confirms a pending payment the provider says succeeded, and audits it", async () => {
    const result = await reconcilePayment("payment_1", opts);

    expect(result).toEqual({ outcome: "CONFIRMED", receiptNumber: "REC-2026-000009" });
    expect(verifyTransaction).toHaveBeenCalledWith(
      { providerTxId: "", internalReference: "PAY-GESA-1" },
      expect.objectContaining({ secretKey: "sk", configValue: "ACCT_x", environment: "TEST" })
    );
    expect(mockedConfirm).toHaveBeenCalledWith("payment_1", {
      providerTxId: "tx_99",
      paidAt: new Date("2026-09-18T11:19:00Z"),
    });
    expect(mockedAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "user_1",
        action: "PAYMENT_RECONCILED",
        metadata: expect.objectContaining({ outcome: "CONFIRMED", source: "admin" }),
      })
    );
  });

  it("leaves a payment the provider says is still in progress untouched", async () => {
    verifyTransaction.mockResolvedValue({ success: false, state: "PENDING", internalReference: "PAY-GESA-1", providerTxId: "tx" });

    const result = await reconcilePayment("payment_1", opts);

    expect(result).toEqual({ outcome: "STILL_PENDING" });
    expect(mockedConfirm).not.toHaveBeenCalled();
    expect(mockedPrisma.payment.updateMany).not.toHaveBeenCalled();
  });

  it("treats an unknown state (adapter without one) as still pending, never as failed", async () => {
    verifyTransaction.mockResolvedValue({ success: false, internalReference: "PAY-GESA-1", providerTxId: "tx" });

    expect((await reconcilePayment("payment_1", opts)).outcome).toBe("STILL_PENDING");
    expect(mockedPrisma.payment.updateMany).not.toHaveBeenCalled();
  });

  it("marks a payment FAILED only when the provider says so, and only if it is still PENDING", async () => {
    verifyTransaction.mockResolvedValue({ success: false, state: "FAILED", internalReference: "PAY-GESA-1", providerTxId: "tx" });

    const result = await reconcilePayment("payment_1", opts);

    expect(result.outcome).toBe("FAILED");
    expect(mockedPrisma.payment.updateMany).toHaveBeenCalledWith({
      where: { id: "payment_1", status: "PENDING" },
      data: { status: "FAILED", failureReason: expect.stringContaining("failed") },
    });
    expect(mockedConfirm).not.toHaveBeenCalled();
  });

  it("doesn't audit a FAILED result when a webhook already settled the payment meanwhile", async () => {
    verifyTransaction.mockResolvedValue({ success: false, state: "FAILED", internalReference: "PAY-GESA-1", providerTxId: "tx" });
    mockedPrisma.payment.updateMany.mockResolvedValue({ count: 0 } as any);

    await reconcilePayment("payment_1", opts);

    expect(mockedAudit).not.toHaveBeenCalled();
  });

  it("reports ERROR and changes nothing when the provider can't be reached", async () => {
    verifyTransaction.mockRejectedValue(new Error("Paystack verification failed with status 401"));

    const result = await reconcilePayment("payment_1", opts);

    expect(result).toEqual({ outcome: "ERROR", message: "Paystack verification failed with status 401" });
    expect(mockedConfirm).not.toHaveBeenCalled();
    expect(mockedPrisma.payment.updateMany).not.toHaveBeenCalled();
  });

  it("refuses a provider answer about a different transaction reference", async () => {
    verifyTransaction.mockResolvedValue({ success: true, state: "SUCCESS", internalReference: "SOMEONE-ELSE", providerTxId: "tx" });

    const result = await reconcilePayment("payment_1", opts);

    expect(result.outcome).toBe("ERROR");
    expect(mockedConfirm).not.toHaveBeenCalled();
  });

  it("does nothing for a payment that is already confirmed with a receipt", async () => {
    mockedPrisma.payment.findUnique.mockResolvedValue(
      pendingPayment({ status: "SUCCESS", receipt: { receiptNumber: "REC-2026-000001" } }) as any
    );

    const result = await reconcilePayment("payment_1", opts);

    expect(result).toEqual({ outcome: "ALREADY_CONFIRMED", receiptNumber: "REC-2026-000001" });
    expect(verifyTransaction).not.toHaveBeenCalled();
  });

  it("finishes the job for a SUCCESS payment that never got its receipt, without asking the provider", async () => {
    mockedPrisma.payment.findUnique.mockResolvedValue(
      pendingPayment({ status: "SUCCESS", providerTxId: "tx_5", paidAt: new Date("2026-09-18T10:00:00Z"), receipt: null }) as any
    );

    const result = await reconcilePayment("payment_1", opts);

    expect(result).toEqual({ outcome: "CONFIRMED", receiptNumber: "REC-2026-000009" });
    expect(mockedConfirm).toHaveBeenCalledWith("payment_1", { providerTxId: "tx_5", paidAt: new Date("2026-09-18T10:00:00Z") });
    expect(verifyTransaction).not.toHaveBeenCalled();
    expect(mockedAudit).toHaveBeenCalledWith(
      expect.objectContaining({ metadata: expect.objectContaining({ healedMissingReceipt: true }) })
    );
  });

  it.each(["FAILED", "CANCELLED", "REFUNDED"])("skips a %s payment", async (status) => {
    mockedPrisma.payment.findUnique.mockResolvedValue(pendingPayment({ status }) as any);

    const result = await reconcilePayment("payment_1", opts);

    expect(result.outcome).toBe("SKIPPED");
    expect(verifyTransaction).not.toHaveBeenCalled();
  });

  it("skips a payment that no longer exists", async () => {
    mockedPrisma.payment.findUnique.mockResolvedValue(null);

    expect((await reconcilePayment("nope", opts)).outcome).toBe("SKIPPED");
  });

  it("skips a department with no payment provider configured", async () => {
    mockedPrisma.payment.findUnique.mockResolvedValue(pendingPayment({ department: { paymentConfig: null } }) as any);

    expect((await reconcilePayment("payment_1", opts)).outcome).toBe("SKIPPED");
    expect(verifyTransaction).not.toHaveBeenCalled();
  });

  it("skips a Hubtel payment with no Hubtel transaction id - there is nothing to look up", async () => {
    mockedPrisma.payment.findUnique.mockResolvedValue(pendingPayment({ department: { paymentConfig: config("HUBTEL") } }) as any);

    const result = await reconcilePayment("payment_1", opts);

    expect(result.outcome).toBe("SKIPPED");
    expect(verifyTransaction).not.toHaveBeenCalled();
  });
});

describe("reconcileStalePayments", () => {
  const batch = { limit: 25, minAgeMs: 120_000, maxAgeMs: 259_200_000, deadlineMs: 45_000 };

  it("looks for old-enough PENDING payments and SUCCESS ones missing a receipt, oldest first, capped by the limit", async () => {
    mockedPrisma.payment.findMany.mockResolvedValue([]);

    await reconcileStalePayments(batch);

    const args = mockedPrisma.payment.findMany.mock.calls[0][0] as any;
    expect(args.take).toBe(25);
    expect(args.orderBy).toEqual({ createdAt: "asc" });
    expect(args.where.OR).toEqual([
      { status: "PENDING", createdAt: { lte: expect.any(Date), gte: expect.any(Date) } },
      { status: "SUCCESS", receipt: { is: null }, updatedAt: { lte: expect.any(Date) } },
    ]);
  });

  it("tallies each outcome", async () => {
    mockedPrisma.payment.findMany.mockResolvedValue([{ id: "a" }, { id: "b" }, { id: "c" }, { id: "d" }] as any);
    mockedPrisma.payment.findUnique
      .mockResolvedValueOnce(pendingPayment({ id: "a" }) as any) // confirmed
      .mockResolvedValueOnce(pendingPayment({ id: "b" }) as any) // still pending
      .mockResolvedValueOnce(pendingPayment({ id: "c" }) as any) // provider error
      .mockResolvedValueOnce(pendingPayment({ id: "d", status: "CANCELLED" }) as any); // skipped
    verifyTransaction
      .mockResolvedValueOnce({ success: true, state: "SUCCESS", providerTxId: "t", internalReference: "PAY-GESA-1", paidAt: null })
      .mockResolvedValueOnce({ success: false, state: "PENDING", providerTxId: "t", internalReference: "PAY-GESA-1" })
      .mockRejectedValueOnce(new Error("timeout"));

    const summary = await reconcileStalePayments(batch);

    expect(summary).toEqual({ checked: 4, confirmed: 1, failed: 0, stillPending: 1, skipped: 1, errors: 1, stoppedEarly: false });
  });

  it("keeps going when one payment blows up unexpectedly", async () => {
    mockedPrisma.payment.findMany.mockResolvedValue([{ id: "a" }, { id: "b" }] as any);
    mockedPrisma.payment.findUnique
      .mockRejectedValueOnce(new Error("db hiccup"))
      .mockResolvedValueOnce(pendingPayment({ id: "b" }) as any);

    const summary = await reconcileStalePayments(batch);

    expect(summary.checked).toBe(2);
    expect(summary.errors).toBe(1);
    expect(summary.confirmed).toBe(1);
  });

  it("stops starting new payments once the deadline has passed", async () => {
    mockedPrisma.payment.findMany.mockResolvedValue([{ id: "a" }, { id: "b" }] as any);

    const summary = await reconcileStalePayments({ ...batch, deadlineMs: -1 });

    expect(summary.stoppedEarly).toBe(true);
    expect(summary.checked).toBe(0);
    expect(mockedPrisma.payment.findUnique).not.toHaveBeenCalled();
  });
});
