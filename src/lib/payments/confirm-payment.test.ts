import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/db", () => ({
  prisma: { payment: { updateMany: vi.fn() } },
}));

// Run "background" tasks inline so the test can observe them; the real
// runInBackground is covered by background.test.ts.
vi.mock("@/lib/background", () => ({
  runInBackground: vi.fn((_label: string, task: () => Promise<unknown>) => task()),
}));

vi.mock("@/lib/receipts", () => ({
  issueReceipt: vi.fn(),
  sendReceiptNotifications: vi.fn(),
}));

import { prisma } from "@/lib/db";
import { runInBackground } from "@/lib/background";
import { issueReceipt, sendReceiptNotifications } from "@/lib/receipts";
import { confirmSuccessfulPayment } from "@/lib/payments/confirm-payment";

const mockedPrisma = vi.mocked(prisma, true);
const mockedIssueReceipt = vi.mocked(issueReceipt);
const mockedSend = vi.mocked(sendReceiptNotifications);

const paidAt = new Date("2026-09-18T11:19:00Z");

beforeEach(() => {
  vi.clearAllMocks();
  mockedPrisma.payment.updateMany.mockResolvedValue({ count: 1 } as any);
  mockedIssueReceipt.mockResolvedValue({ receipt: { receiptNumber: "REC-2026-000001" }, created: true } as any);
  mockedSend.mockResolvedValue({ sms: "SENT", email: "SENT" });
});

describe("confirmSuccessfulPayment", () => {
  it("flips the payment to SUCCESS with a conditional update that never touches an already-SUCCESS row", async () => {
    await confirmSuccessfulPayment("payment_1", { providerTxId: "tx_1", paidAt });

    expect(mockedPrisma.payment.updateMany).toHaveBeenCalledWith({
      where: { id: "payment_1", status: { not: "SUCCESS" } },
      data: { status: "SUCCESS", providerTxId: "tx_1", paidAt, failureReason: null },
    });
  });

  it("falls back to now when the provider gives no paid-at time", async () => {
    await confirmSuccessfulPayment("payment_1", { providerTxId: "tx_1", paidAt: null });

    const data = mockedPrisma.payment.updateMany.mock.calls[0][0].data as { paidAt: Date };
    expect(data.paidAt).toBeInstanceOf(Date);
  });

  it("queues SMS/email in the background when THIS call created the receipt", async () => {
    const result = await confirmSuccessfulPayment("payment_1", { providerTxId: "tx_1", paidAt });

    expect(runInBackground).toHaveBeenCalledWith("receipt-notifications", expect.any(Function));
    expect(mockedSend).toHaveBeenCalledWith("payment_1");
    expect(result).toEqual({ newlyConfirmed: true, receiptNumber: "REC-2026-000001", receiptCreated: true });
  });

  it("does NOT queue notifications when another caller already created the receipt (no double SMS)", async () => {
    mockedIssueReceipt.mockResolvedValue({ receipt: { receiptNumber: "REC-2026-000001" }, created: false } as any);

    const result = await confirmSuccessfulPayment("payment_1", { providerTxId: "tx_1", paidAt });

    expect(runInBackground).not.toHaveBeenCalled();
    expect(mockedSend).not.toHaveBeenCalled();
    expect(result.receiptCreated).toBe(false);
  });

  it("reports newlyConfirmed: false when the payment was already SUCCESS", async () => {
    mockedPrisma.payment.updateMany.mockResolvedValue({ count: 0 } as any);
    mockedIssueReceipt.mockResolvedValue({ receipt: { receiptNumber: "REC-2026-000001" }, created: false } as any);

    const result = await confirmSuccessfulPayment("payment_1", { providerTxId: "tx_1", paidAt });

    expect(result.newlyConfirmed).toBe(false);
  });
});
