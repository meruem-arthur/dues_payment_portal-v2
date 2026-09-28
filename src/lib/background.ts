import { waitUntil } from "@vercel/functions";
import { captureError } from "@/lib/monitoring/capture-error";

/**
 * Runs `task` after the HTTP response has been sent, without making the
 * caller wait for it.
 *
 * Why this exists: on Vercel a serverless function is normally frozen the
 * moment its response is returned, so a bare un-awaited promise can be
 * killed halfway through. `waitUntil` tells the platform to keep the
 * function alive until the promise settles (bounded by the function's
 * maxDuration), which is what lets the payment webhook answer the provider
 * in milliseconds while SMS/email receipts are still being sent.
 *
 * Errors are caught and reported here, never thrown - a background task
 * has no caller left to handle them, and must never turn a successful
 * response into a failure.
 *
 * Outside Vercel (local dev, tests) `waitUntil` is a no-op and the promise
 * simply runs on its own; the returned promise lets tests await it.
 */
export function runInBackground(label: string, task: () => Promise<unknown>): Promise<void> {
  const promise = (async () => {
    try {
      await task();
    } catch (err) {
      captureError(err, { context: label });
    }
  })();

  try {
    waitUntil(promise);
  } catch {
    // Not running inside a Vercel request context - nothing to register with.
  }

  return promise;
}
