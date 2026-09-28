import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/payments/reconcile", () => ({ reconcileStalePayments: vi.fn() }));
vi.mock("@/lib/monitoring/capture-error", () => ({ captureError: vi.fn() }));

import { reconcileStalePayments } from "@/lib/payments/reconcile";
import { GET } from "./route";

const mockedReconcile = vi.mocked(reconcileStalePayments);
const summary = { checked: 2, confirmed: 1, failed: 0, stillPending: 1, skipped: 0, errors: 0, stoppedEarly: false };

function makeRequest(authorization?: string) {
  return new NextRequest("http://localhost/api/cron/reconcile-payments", {
    headers: authorization ? { authorization } : {},
  });
}

const originalSecret = process.env.CRON_SECRET;
beforeEach(() => {
  vi.clearAllMocks();
  process.env.CRON_SECRET = "s3cret-value";
  mockedReconcile.mockResolvedValue(summary);
});
afterEach(() => {
  if (originalSecret === undefined) delete process.env.CRON_SECRET;
  else process.env.CRON_SECRET = originalSecret;
});

describe("GET /api/cron/reconcile-payments", () => {
  it("runs the sweep and returns its summary for a correct bearer secret", async () => {
    const res = await GET(makeRequest("Bearer s3cret-value"));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(summary);
    expect(mockedReconcile).toHaveBeenCalledWith(
      expect.objectContaining({ limit: expect.any(Number), minAgeMs: expect.any(Number), maxAgeMs: expect.any(Number), deadlineMs: expect.any(Number) })
    );
  });

  it("rejects a request with no Authorization header", async () => {
    const res = await GET(makeRequest());
    expect(res.status).toBe(401);
    expect(mockedReconcile).not.toHaveBeenCalled();
  });

  it("rejects a wrong secret", async () => {
    const res = await GET(makeRequest("Bearer not-the-secret"));
    expect(res.status).toBe(401);
    expect(mockedReconcile).not.toHaveBeenCalled();
  });

  it("rejects a secret without the Bearer prefix", async () => {
    const res = await GET(makeRequest("s3cret-value"));
    expect(res.status).toBe(401);
  });

  it("is closed to everyone while CRON_SECRET is unset - even for 'Bearer undefined'", async () => {
    delete process.env.CRON_SECRET;

    expect((await GET(makeRequest("Bearer undefined"))).status).toBe(401);
    expect((await GET(makeRequest("Bearer "))).status).toBe(401);
    expect(mockedReconcile).not.toHaveBeenCalled();
  });

  it("returns 500 (and not the error detail) if the sweep itself throws", async () => {
    mockedReconcile.mockRejectedValue(new Error("db exploded with secret details"));

    const res = await GET(makeRequest("Bearer s3cret-value"));

    expect(res.status).toBe(500);
    expect(JSON.stringify(await res.json())).not.toContain("secret details");
  });
});
