"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

/**
 * Re-runs the (server-rendered) payment status page every few seconds while a
 * payment is still PENDING, so a student who just paid sees "Payment
 * Successful" appear by itself instead of having to refresh manually. Each
 * refresh makes the server check with the payment provider (see the page),
 * and it gives up after a while so an abandoned tab doesn't poll forever.
 *
 * Only rendered while the payment is pending - once it resolves the page no
 * longer includes this component, which stops the polling.
 */
export function PaymentStatusRefresher({
  intervalMs = 6000,
  maxRefreshes = 15,
}: {
  intervalMs?: number;
  maxRefreshes?: number;
}) {
  const router = useRouter();

  useEffect(() => {
    let count = 0;
    const timer = setInterval(() => {
      count += 1;
      router.refresh();
      if (count >= maxRefreshes) clearInterval(timer);
    }, intervalMs);
    return () => clearInterval(timer);
  }, [router, intervalMs, maxRefreshes]);

  return null;
}
