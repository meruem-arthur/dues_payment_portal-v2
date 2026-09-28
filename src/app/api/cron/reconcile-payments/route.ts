import { NextRequest, NextResponse } from "next/server";
import crypto from "crypto";
import { reconcileStalePayments } from "@/lib/payments/reconcile";
import { captureError } from "@/lib/monitoring/capture-error";

// GET /api/cron/reconcile-payments
//
// Safety-net sweep for payments whose webhook never arrived: PENDING ones
// old enough that it should have, and SUCCESS ones that never got a receipt.
// The real-time recovery paths are the status page (verifies when a student
// returns from checkout) and the admin "Check payment" button - this just
// catches whatever slipped past both.
//
// Auth: Vercel automatically sends `Authorization: Bearer $CRON_SECRET` on
// cron invocations when the CRON_SECRET env var is set. The same header lets
// an external scheduler call this more often than Vercel's Hobby plan allows
// (Hobby cron runs at most once a day). If CRON_SECRET isn't set the route is
// closed to everyone - it must never be open by default, since it triggers
// calls out to payment providers.

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const MIN_AGE_MS = 2 * 60 * 1000; // give the webhook a fair chance first
const MAX_AGE_MS = 3 * 24 * 60 * 60 * 1000; // abandoned checkouts older than this aren't worth chasing
const BATCH_LIMIT = 25;
const DEADLINE_MS = 45 * 1000; // stop starting new payments well before maxDuration

function isAuthorized(req: NextRequest): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  const header = req.headers.get("authorization") ?? "";
  const expected = `Bearer ${secret}`;
  const a = Buffer.from(header);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

export async function GET(req: NextRequest) {
  if (!isAuthorized(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const summary = await reconcileStalePayments({
      limit: BATCH_LIMIT,
      minAgeMs: MIN_AGE_MS,
      maxAgeMs: MAX_AGE_MS,
      deadlineMs: DEADLINE_MS,
    });
    return NextResponse.json(summary);
  } catch (err) {
    captureError(err, { context: "cron-reconcile-payments" });
    return NextResponse.json({ error: "Reconcile run failed" }, { status: 500 });
  }
}
