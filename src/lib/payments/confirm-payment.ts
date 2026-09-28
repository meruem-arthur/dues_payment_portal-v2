import { prisma } from "@/lib/db";
import { runInBackground } from "@/lib/background";
import { issueReceipt, sendReceiptNotifications } from "@/lib/receipts";

/**
 * The single place a payment becomes SUCCESS.
 *
 * Four different code paths can discover that a payment went through - the
 * Paystack webhook, the Hubtel webhook, the reconcile job (status page,
 * admin "Check payment", daily cron) - and they can do so at the same
 * moment. Funnelling them all through here is what keeps that safe:
 *
 *  1. The status flip is a conditional update (`status != SUCCESS`), so it
 *     is idempotent and never overwrites a payment that is already done.
 *  2. issueReceipt() lets exactly one caller create the receipt.
 *  3. Only that caller queues the SMS/email, so a student is never texted
 *     twice for one payment.
 *
 * The caller is responsible for having verified the payment with the
 * provider first - this function trusts what it is given.
 *
 * SMS/email run AFTER the response (see runInBackground), so the webhook
 * can acknowledge the provider immediately instead of holding the request
 * open for however long Arkesel and Brevo take. Their failures are logged
 * to NotificationLog by the send functions themselves and can never affect
 * the payment or receipt.
 */
export async function confirmSuccessfulPayment(
  paymentId: string,
  verified: { providerTxId: string; paidAt: Date | null }
) {
  const claim = await prisma.payment.updateMany({
    where: { id: paymentId, status: { not: "SUCCESS" } },
    data: {
      status: "SUCCESS",
      providerTxId: verified.providerTxId,
      paidAt: verified.paidAt ?? new Date(),
      // A payment that failed earlier and then went through (customer
      // retried inside the same checkout) shouldn't keep a stale reason.
      failureReason: null,
    },
  });

  const { receipt, created } = await issueReceipt(paymentId);

  if (created) {
    runInBackground("receipt-notifications", () => sendReceiptNotifications(paymentId));
  }

  return {
    newlyConfirmed: claim.count > 0,
    receiptNumber: receipt.receiptNumber,
    receiptCreated: created,
  };
}
