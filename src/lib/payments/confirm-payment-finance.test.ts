import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/db", () => ({ prisma: { payment: { updateMany: vi.fn() } } }));
vi.mock("@/lib/background", () => ({
  runInBackground: vi.fn((_l: string, task: () => Promise<unknown>) => task()),
}));
vi.mock("@/lib/receipts", () => ({
  issueReceipt: vi.fn().mockResolvedValue({ receipt: { receiptNumber: "REC-1" }, created: false }),
  sendReceiptNotifications: vi.fn(),
}));
vi.mock("@/lib/finance/push", () => ({ queueFinancePush: vi.fn() }));

import { prisma } from "@/lib/db";
import { queueFinancePush } from "@/lib/finance/push";
import { confirmSuccessfulPayment } from "@/lib/payments/confirm-payment";

const paidAt = new Date("2026-09-18T11:19:00Z");

beforeEach(() => vi.clearAllMocks());

describe("confirmSuccessfulPayment -> finance push", () => {
  it("announces a payment only when this call is the one that confirmed it", async () => {
    vi.mocked(prisma, true).payment.updateMany.mockResolvedValue({ count: 1 } as any);
    await confirmSuccessfulPayment("pay_1", { providerTxId: "tx", paidAt });
    expect(queueFinancePush).toHaveBeenCalledWith("pay_1");
  });

  it("stays silent when the payment was already SUCCESS (duplicate webhook)", async () => {
    vi.mocked(prisma, true).payment.updateMany.mockResolvedValue({ count: 0 } as any);
    await confirmSuccessfulPayment("pay_1", { providerTxId: "tx", paidAt });
    expect(queueFinancePush).not.toHaveBeenCalled();
  });
});
