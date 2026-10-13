import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/db", () => ({
  prisma: {
    payment: { findMany: vi.fn(), deleteMany: vi.fn() },
    receipt: { count: vi.fn() },
    notificationLog: { deleteMany: vi.fn() },
    student: { delete: vi.fn() },
    $transaction: vi.fn(),
  },
}));
vi.mock("@/lib/payments/reconcile", () => ({ reconcilePayment: vi.fn() }));

import { prisma } from "@/lib/db";
import { reconcilePayment } from "@/lib/payments/reconcile";
import { deleteStudentWithPaymentAttempts, DELETE_PENDING_GRACE_MS } from "./delete-student";

const db = vi.mocked(prisma, true);
const reconcile = vi.mocked(reconcilePayment);

const old = new Date(Date.now() - DELETE_PENDING_GRACE_MS - 60_000);
const fresh = new Date(Date.now() - 60_000);
const pay = (id: string, status: string, createdAt = old) => ({ id, status, createdAt });

function setup(payments: any[], receipts = 0) {
  db.payment.findMany.mockResolvedValue(payments as any);
  db.receipt.count.mockResolvedValue(receipts);
  db.$transaction.mockResolvedValue([{ count: 1 }, { count: payments.length }, {}] as any);
}
const run = () => deleteStudentWithPaymentAttempts({ id: "s1" }, "admin1");

beforeEach(() => {
  vi.resetAllMocks();
});

describe("deleteStudentWithPaymentAttempts", () => {
  it("deletes a student with failed, cancelled and abandoned pending attempts", async () => {
    setup([pay("a", "FAILED"), pay("b", "CANCELLED"), pay("c", "PENDING")]);
    reconcile.mockResolvedValue({ outcome: "STILL_PENDING" } as any);
    const r = await run();
    expect(r).toEqual({ ok: true, deletedPayments: 3 });
    expect(db.$transaction).toHaveBeenCalledTimes(1);
    expect(db.payment.deleteMany).toHaveBeenCalledWith({
      where: { studentId: "s1", status: { notIn: ["SUCCESS", "REFUNDED"] } },
    });
  });

  it("deletes a student with no payments at all", async () => {
    setup([]);
    expect((await run()).ok).toBe(true);
    expect(reconcile).not.toHaveBeenCalled();
  });

  it.each(["SUCCESS", "REFUNDED"])("blocks a student with a %s payment", async (status) => {
    setup([pay("a", status)]);
    const r = await run();
    expect(r).toMatchObject({ ok: false, code: "HAS_PAID" });
    expect(db.$transaction).not.toHaveBeenCalled();
  });

  it("blocks a student with a receipt", async () => {
    setup([pay("a", "FAILED")], 1);
    expect(await run()).toMatchObject({ ok: false, code: "HAS_PAID" });
    expect(db.$transaction).not.toHaveBeenCalled();
  });

  it("blocks a pending payment under 15 minutes old without calling the provider", async () => {
    setup([pay("a", "PENDING", fresh)]);
    expect(await run()).toMatchObject({ ok: false, code: "PAYMENT_IN_PROGRESS" });
    expect(reconcile).not.toHaveBeenCalled();
    expect(db.$transaction).not.toHaveBeenCalled();
  });

  it.each(["CONFIRMED", "ALREADY_CONFIRMED"])("blocks when the provider says it was paid (%s)", async (outcome) => {
    setup([pay("a", "PENDING")]);
    reconcile.mockResolvedValue({ outcome } as any);
    expect(await run()).toMatchObject({ ok: false, code: "PAYMENT_JUST_CONFIRMED" });
    expect(db.$transaction).not.toHaveBeenCalled();
  });

  it("blocks when the provider can't be asked (ERROR)", async () => {
    setup([pay("a", "PENDING")]);
    reconcile.mockResolvedValue({ outcome: "ERROR", message: "timeout" } as any);
    const r = await run();
    expect(r).toMatchObject({ ok: false, code: "CANNOT_VERIFY" });
    expect((r as any).message).toContain("timeout");
    expect(db.$transaction).not.toHaveBeenCalled();
  });

  it("blocks when verification is skipped (SKIPPED)", async () => {
    setup([pay("a", "PENDING")]);
    reconcile.mockResolvedValue({ outcome: "SKIPPED", reason: "no config" } as any);
    const r = await run();
    expect(r).toMatchObject({ ok: false, code: "CANNOT_VERIFY" });
    expect((r as any).message).toContain("no config");
  });

  it("allows deletion when the provider reports FAILED", async () => {
    setup([pay("a", "PENDING")]);
    reconcile.mockResolvedValue({ outcome: "FAILED" } as any);
    expect((await run()).ok).toBe(true);
  });

  it("reports HAS_PAID when a payment appears mid-delete (FK violation)", async () => {
    setup([pay("a", "FAILED")]);
    db.$transaction.mockRejectedValue(Object.assign(new Error("fk"), { code: "P2003" }));
    expect(await run()).toMatchObject({ ok: false, code: "HAS_PAID" });
  });

  it("rethrows unexpected errors", async () => {
    setup([pay("a", "FAILED")]);
    db.$transaction.mockRejectedValue(new Error("db down"));
    await expect(run()).rejects.toThrow("db down");
  });
});
