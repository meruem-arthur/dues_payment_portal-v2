import { prisma } from "@/lib/db";
import { reconcilePayment } from "@/lib/payments/reconcile";

/**
 * A pending payment younger than this blocks deleting its student: they may
 * still be on the provider's checkout page, and deleting the row underneath
 * a payment that then completes would leave money taken with no record.
 * (Deliberately much shorter than PENDING_PAYMENT_STALE_AFTER_MS - that one
 * decides when a student may START a new payment, this one only needs to
 * cover "is somebody actively paying right now".)
 */
export const DELETE_PENDING_GRACE_MS = 15 * 60 * 1000;

export type DeleteStudentFailure = {
  ok: false;
  code: "HAS_PAID" | "PAYMENT_IN_PROGRESS" | "PAYMENT_JUST_CONFIRMED" | "CANNOT_VERIFY";
  message: string;
};

export type DeleteStudentResult = { ok: true; deletedPayments: number } | DeleteStudentFailure;

/**
 * Deletes a student together with their UNSUCCESSFUL payment attempts.
 *
 * Why this exists: a student who started paying and gave up (wrong reference
 * number, closed the tab, failed card...) has payment rows with status
 * PENDING / FAILED / CANCELLED. Those rows hold a foreign key to the
 * student, so a bare `student.delete` is always refused by the database -
 * which is what made the Delete button silently do nothing.
 *
 * Rules, in order:
 *  1. Anyone with a successful or refunded payment, or any receipt, is never
 *     deleted - that is financial history.
 *  2. A pending payment started in the last DELETE_PENDING_GRACE_MS blocks the
 *     delete (the student may still be paying).
 *  3. Every other pending payment is checked with the payment provider
 *     first. If the provider says it went through, it is confirmed (receipt
 *     issued) and the delete is refused. If the provider can't be asked, the
 *     delete is refused too - an admin who has checked by hand can use
 *     "Cancel Pending Payment" first, which turns them into CANCELLED rows
 *     that this function will happily remove.
 *  4. Otherwise the notification logs, payment attempts and student are
 *     removed in ONE transaction. The foreign keys stay as the last line of
 *     defence: if a payment succeeds between the checks above and the delete,
 *     the transaction fails and nothing is removed.
 */
export async function deleteStudentWithPaymentAttempts(
  student: { id: string },
  actorUserId: string
): Promise<DeleteStudentResult> {
  const [payments, receiptCount] = await Promise.all([
    prisma.payment.findMany({
      where: { studentId: student.id },
      select: { id: true, status: true, createdAt: true },
    }),
    prisma.receipt.count({ where: { studentId: student.id } }),
  ]);

  const hasFinancialHistory =
    receiptCount > 0 || payments.some((p: { status: string }) => p.status === "SUCCESS" || p.status === "REFUNDED");
  if (hasFinancialHistory) {
    return {
      ok: false,
      code: "HAS_PAID",
      message:
        "This student has a successful payment or a receipt on record, so they can't be deleted - payment records are financial history.",
    };
  }

  const pending = payments.filter((p: { status: string }) => p.status === "PENDING");

  const tooRecent = pending.some(
    (p: { createdAt: Date }) => Date.now() - p.createdAt.getTime() < DELETE_PENDING_GRACE_MS
  );
  if (tooRecent) {
    return {
      ok: false,
      code: "PAYMENT_IN_PROGRESS",
      message: "This student started a payment in the last few minutes and may still be completing it. Try again shortly.",
    };
  }

  for (const p of pending as { id: string }[]) {
    const result = await reconcilePayment(p.id, { source: "admin", actorUserId });

    if (result.outcome === "CONFIRMED" || result.outcome === "ALREADY_CONFIRMED") {
      return {
        ok: false,
        code: "PAYMENT_JUST_CONFIRMED",
        message:
          "The payment provider says this student's payment actually went through, so it has been confirmed instead and the student can't be deleted.",
      };
    }

    if (result.outcome === "ERROR" || result.outcome === "SKIPPED") {
      const why = result.outcome === "ERROR" ? result.message : result.reason;
      return {
        ok: false,
        code: "CANNOT_VERIFY",
        message: `Couldn't confirm with the payment provider whether a pending payment went through (${why}). Try again, or - if you've checked and it didn't go through - use "Cancel Pending Payment" first, then delete.`,
      };
    }
    // STILL_PENDING (abandoned checkout) and FAILED are both safe to remove.
  }

  try {
    const [, removed] = await prisma.$transaction([
      prisma.notificationLog.deleteMany({
        where: { relatedPaymentId: { in: payments.map((p: { id: string }) => p.id) } },
      }),
      // Never targets a SUCCESS/REFUNDED row. If one appeared since the
      // checks above, the student delete below hits the foreign key and the
      // whole transaction rolls back.
      prisma.payment.deleteMany({
        where: { studentId: student.id, status: { notIn: ["SUCCESS", "REFUNDED"] } },
      }),
      prisma.student.delete({ where: { id: student.id } }),
    ]);
    return { ok: true, deletedPayments: removed.count };
  } catch (err: any) {
    // P2003 = foreign key violation: a payment/receipt appeared mid-way.
    if (err?.code === "P2003") {
      return {
        ok: false,
        code: "HAS_PAID",
        message: "A payment for this student was just recorded, so nothing was deleted. Refresh and check their status.",
      };
    }
    throw err;
  }
}
