import { prisma } from "@/lib/db";
import { logAudit } from "@/lib/audit";
import { captureError } from "@/lib/monitoring/capture-error";
import { decryptPaymentSecrets } from "@/lib/crypto/field-encryption";
import { getPaymentProvider } from "@/lib/payments/provider-factory";
import { confirmSuccessfulPayment } from "@/lib/payments/confirm-payment";

/**
 * Reconciliation: asking the payment provider directly what happened to a
 * payment, instead of waiting for its webhook to tell us.
 *
 * The webhook is still the normal path. This exists for when it doesn't
 * arrive (webhook URL not set or wrong, provider outage, our own outage
 * during delivery, a function killed mid-request) - previously every one
 * of those left a paid student showing PENDING forever.
 *
 * It is safe for this to mark a payment paid, unlike trusting the browser
 * redirect: the answer comes from a server-to-server call to the provider
 * using the department's own secret key, and the result goes through the
 * same confirmSuccessfulPayment() the webhooks use.
 */

export type ReconcileSource = "status-page" | "admin" | "cron";

export type ReconcileOutcome =
  | { outcome: "CONFIRMED"; receiptNumber: string }
  | { outcome: "ALREADY_CONFIRMED"; receiptNumber: string | null }
  | { outcome: "STILL_PENDING" }
  | { outcome: "FAILED"; reason: string }
  | { outcome: "SKIPPED"; reason: string }
  | { outcome: "ERROR"; message: string };

export async function reconcilePayment(
  paymentId: string,
  opts: { source: ReconcileSource; actorUserId?: string | null }
): Promise<ReconcileOutcome> {
  const payment = await prisma.payment.findUnique({
    where: { id: paymentId },
    include: { department: { include: { paymentConfig: true } }, receipt: true },
  });

  if (!payment) return { outcome: "SKIPPED", reason: "Payment not found" };

  // Already paid. If the receipt is missing the process died between
  // "mark paid" and "issue receipt" - finish the job rather than leaving a
  // paid student without one.
  if (payment.status === "SUCCESS") {
    if (payment.receipt) return { outcome: "ALREADY_CONFIRMED", receiptNumber: payment.receipt.receiptNumber };

    const done = await confirmSuccessfulPayment(payment.id, {
      providerTxId: payment.providerTxId ?? "",
      paidAt: payment.paidAt,
    });
    await audit(payment, opts, "CONFIRMED", { healedMissingReceipt: true });
    return { outcome: "CONFIRMED", receiptNumber: done.receiptNumber };
  }

  // Only PENDING payments are worth asking about. FAILED / CANCELLED /
  // REFUNDED are settled, and a late success on a FAILED one still arrives
  // through the webhook.
  if (payment.status !== "PENDING") {
    return { outcome: "SKIPPED", reason: `Payment is ${payment.status}` };
  }

  const config = payment.department.paymentConfig;
  if (!config) return { outcome: "SKIPPED", reason: "No payment provider configured for this department" };

  // Hubtel verifies by ITS transaction id, which we only learn from a
  // webhook - so for a Hubtel payment whose webhook never came there is
  // nothing to look up. Paystack verifies by our own reference, so it is
  // always possible.
  if (config.provider === "HUBTEL" && !payment.providerTxId) {
    return { outcome: "SKIPPED", reason: "Hubtel payments can only be verified once Hubtel's transaction id is known" };
  }

  const secrets = decryptPaymentSecrets(config);

  let verified;
  try {
    verified = await getPaymentProvider(config.provider as "PAYSTACK" | "HUBTEL").verifyTransaction(
      { providerTxId: payment.providerTxId ?? "", internalReference: payment.internalReference },
      {
        publicKey: secrets.publicKey,
        secretKey: secrets.secretKey,
        webhookSecret: secrets.webhookSecret,
        configValue: secrets.configValue,
        environment: secrets.environment,
      }
    );
  } catch (err) {
    // Network error, bad key, provider outage: nothing learned, nothing
    // changed. It stays PENDING and will be looked at again.
    captureError(err, { context: "reconcile-verify", paymentId: payment.id });
    return { outcome: "ERROR", message: err instanceof Error ? err.message : "Could not reach the payment provider" };
  }

  // Same guard the webhooks use: the provider must be talking about OUR payment.
  if (verified.internalReference !== payment.internalReference) {
    return { outcome: "ERROR", message: "The provider returned a different transaction reference" };
  }

  if (verified.success) {
    const done = await confirmSuccessfulPayment(payment.id, {
      providerTxId: verified.providerTxId,
      paidAt: verified.paidAt,
    });
    await audit(payment, opts, "CONFIRMED", { providerTxId: verified.providerTxId });
    return { outcome: "CONFIRMED", receiptNumber: done.receiptNumber };
  }

  if (verified.state === "FAILED") {
    const reason = "The payment provider reported this transaction as failed";
    // Conditional on PENDING so this can never overwrite a payment that a
    // webhook confirmed while we were waiting on the provider.
    const res = await prisma.payment.updateMany({
      where: { id: payment.id, status: "PENDING" },
      data: { status: "FAILED", failureReason: reason },
    });
    if (res.count > 0) await audit(payment, opts, "FAILED", {});
    return { outcome: "FAILED", reason };
  }

  // Not finished yet (customer still on the checkout page, mobile-money
  // prompt not approved, abandoned but resumable...). Leave it alone.
  return { outcome: "STILL_PENDING" };
}

async function audit(
  payment: { id: string; departmentId: string },
  opts: { source: ReconcileSource; actorUserId?: string | null },
  outcome: "CONFIRMED" | "FAILED",
  extra: Record<string, string | boolean>
) {
  await logAudit({
    userId: opts.actorUserId ?? null,
    departmentId: payment.departmentId,
    action: "PAYMENT_RECONCILED",
    entity: "Payment",
    entityId: payment.id,
    metadata: { outcome, source: opts.source, ...extra },
  });
}

export type ReconcileBatchSummary = {
  checked: number;
  confirmed: number;
  failed: number;
  stillPending: number;
  skipped: number;
  errors: number;
  stoppedEarly: boolean;
};

/**
 * Sweep for payments that need a second look: PENDING ones old enough that
 * a webhook should already have arrived, and SUCCESS ones that never got a
 * receipt. Bounded three ways so one run can't run away - a row limit, an
 * age window (very old abandoned checkouts aren't worth chasing), and a
 * deadline checked between payments so the function returns before the
 * platform's time limit.
 */
export async function reconcileStalePayments(opts: {
  limit: number;
  minAgeMs: number;
  maxAgeMs: number;
  deadlineMs: number;
}): Promise<ReconcileBatchSummary> {
  const startedAt = Date.now();
  const olderThan = new Date(startedAt - opts.minAgeMs);
  const newerThan = new Date(startedAt - opts.maxAgeMs);

  const candidates = await prisma.payment.findMany({
    where: {
      OR: [
        { status: "PENDING", createdAt: { lte: olderThan, gte: newerThan } },
        { status: "SUCCESS", receipt: { is: null }, updatedAt: { lte: olderThan } },
      ],
    },
    orderBy: { createdAt: "asc" },
    take: opts.limit,
    select: { id: true },
  });

  const summary: ReconcileBatchSummary = {
    checked: 0,
    confirmed: 0,
    failed: 0,
    stillPending: 0,
    skipped: 0,
    errors: 0,
    stoppedEarly: false,
  };

  for (const candidate of candidates) {
    if (Date.now() - startedAt > opts.deadlineMs) {
      summary.stoppedEarly = true;
      break;
    }

    summary.checked += 1;
    try {
      const result = await reconcilePayment(candidate.id, { source: "cron" });
      switch (result.outcome) {
        case "CONFIRMED":
          summary.confirmed += 1;
          break;
        case "FAILED":
          summary.failed += 1;
          break;
        case "STILL_PENDING":
          summary.stillPending += 1;
          break;
        case "ERROR":
          summary.errors += 1;
          break;
        default:
          summary.skipped += 1;
      }
    } catch (err) {
      // One bad payment must not stop the sweep.
      captureError(err, { context: "reconcile-batch", paymentId: candidate.id });
      summary.errors += 1;
    }
  }

  return summary;
}
