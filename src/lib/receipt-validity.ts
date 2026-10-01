/**
 * Single rule for "is this receipt still valid?", used by the public
 * /verify/[receiptNumber] page.
 *
 * - PAYMENT receipt: valid while its payment is SUCCESS.
 * - CLEARANCE receipt (no payment behind it): valid only while it has not
 *   been voided AND the student is still marked Dues Cleared. Removing a
 *   clearance voids the receipt, so a printed/forwarded copy stops
 *   verifying without the row ever being deleted.
 */
export function isReceiptValid(
  receipt: {
    kind: "PAYMENT" | "CLEARANCE";
    voidedAt: Date | null;
    payment: { status: string } | null;
    student: { isExempt: boolean };
  } | null
): boolean {
  if (!receipt) return false;
  if (receipt.kind === "CLEARANCE") return !receipt.voidedAt && receipt.student.isExempt;
  return receipt.payment?.status === "SUCCESS";
}
