import { prisma } from "@/lib/db";
import { runInBackground } from "@/lib/background";
import { departmentCodesMatch, getFinanceConfig, isFinancePushEnabled } from "./config";
import { financePaymentSelect, toFinancePayload } from "./payload";
import { signPush } from "./signing";

/**
 * Tells the finance portal that a payment changed.
 *
 * Best-effort by design: it runs after the response (see runInBackground) and
 * a failure never affects the payment. The finance portal also runs a
 * scheduled catch-up sync against /api/finance/payments, so a missed push is
 * corrected on the next sync.
 */
export async function pushPaymentToFinance(paymentId: string): Promise<void> {
  const config = getFinanceConfig();
  if (!isFinancePushEnabled(config)) return;

  const row = await prisma.payment.findUnique({ where: { id: paymentId }, select: financePaymentSelect });
  if (!row) return;
  if (!departmentCodesMatch(row.department.code, config.departmentCode)) return;

  const body = JSON.stringify({ event: "payment.updated", payment: toFinancePayload(row) });
  const timestamp = Math.floor(Date.now() / 1000);
  const signature = signPush(body, timestamp, config.pushToken as string);

  const res = await fetch(`${config.portalUrl}/api/webhooks/dues`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-dues-timestamp": String(timestamp),
      "x-dues-signature": signature,
    },
    body,
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new Error(`Finance portal rejected payment push (${res.status})`);
}

/**
 * Fire-and-forget wrapper. Returns without scheduling anything when the
 * integration isn't configured, so deployments that don't use the finance
 * portal are completely unaffected.
 *
 * Call this after ANY code path that sets a payment to SUCCESS or REFUNDED
 * (today only confirmSuccessfulPayment does; nothing sets REFUNDED yet).
 */
export function queueFinancePush(paymentId: string): void {
  if (!isFinancePushEnabled()) return;
  void runInBackground("finance-push", () => pushPaymentToFinance(paymentId));
}
