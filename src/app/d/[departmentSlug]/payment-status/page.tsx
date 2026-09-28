import { prisma } from "@/lib/db";
import { ReceiptActions } from "@/components/receipts/receipt-actions";
import { PaymentStatusRefresher } from "@/components/receipts/payment-status-refresher";
import { reconcilePayment } from "@/lib/payments/reconcile";
import { checkRateLimit } from "@/lib/rate-limit";

// The browser redirect back from checkout never decides whether a payment
// succeeded - the URL says nothing we'd trust. What this page does instead
// is ask the payment provider directly, server-to-server (reconcilePayment),
// when a payment is still PENDING. That closes the gap when the provider's
// webhook is late or never arrives; if the webhook has already landed, this
// just reads the finished result.
export const dynamic = "force-dynamic";

const findPayment = (ref: string) =>
  prisma.payment.findUnique({
    where: { internalReference: ref },
    include: { student: true, receipt: true },
  });

export default async function PaymentStatusPage({
  searchParams,
}: {
  searchParams: { ref?: string };
}) {
  let payment = searchParams.ref ? await findPayment(searchParams.ref) : null;

  if (payment && payment.status === "PENDING") {
    // The page polls itself while pending (PaymentStatusRefresher), so cap how
    // often one reference can trigger a call out to the provider.
    const limit = checkRateLimit(`payment-status-verify:${payment.internalReference}`, 12, 60_000);
    if (limit.allowed) {
      try {
        await reconcilePayment(payment.id, { source: "status-page" });
        payment = await findPayment(payment.internalReference);
      } catch {
        // Verification is best-effort here; fall through and show whatever
        // state we have. reconcilePayment reports its own errors.
      }
    }
  }

  if (!payment) {
    return (
      <main className="portal-shell flex min-h-screen items-center justify-center px-4 text-center">
        <p className="portal-content text-portal-muted">We could not find that payment. If you were charged, contact your department.</p>
      </main>
    );
  }

  const isPending = payment.status === "PENDING";

  // payment.amount is a Prisma Decimal - format as plain "150" / "150.50".
  const amountNumber = Number(payment.amount);
  const amountDisplay = Number.isInteger(amountNumber) ? amountNumber.toString() : amountNumber.toFixed(2);

  return (
    <main className="portal-shell flex min-h-screen flex-col items-center justify-center gap-4 px-4 text-center">
      <div className="portal-content portal-card max-w-md space-y-3 p-8">
        <h1 className="text-2xl font-bold text-portal-text">
          {payment.status === "SUCCESS" ? "Payment Successful" : isPending ? "Confirming Payment..." : "Payment Not Completed"}
        </h1>
        <p className="text-portal-muted">
          {isPending
            ? "We're waiting for confirmation from the payment provider. This page checks again every few seconds for about a minute and a half - if it still says pending after that, check back later or watch for your SMS receipt."
            : payment.status === "SUCCESS"
            ? `Receipt ${payment.receipt?.receiptNumber ?? ""} has been issued for GHS ${amountDisplay}. You can download it below, and a copy is also being sent to ${payment.student.phone} by SMS.`
            : "Your payment was not successful. Please try again or contact your department."}
        </p>
        {isPending && <PaymentStatusRefresher />}
        {payment.status === "SUCCESS" && payment.receipt && (
          <ReceiptActions
            downloadUrl={`/api/receipts/download?ref=${encodeURIComponent(payment.internalReference)}`}
            fileName={`${payment.receipt.receiptNumber}.pdf`}
          />
        )}
      </div>
    </main>
  );
}
