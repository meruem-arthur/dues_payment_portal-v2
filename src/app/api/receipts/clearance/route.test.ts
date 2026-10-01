import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/receipts", () => ({ buildClearanceReceiptPdf: vi.fn() }));

import { buildClearanceReceiptPdf } from "@/lib/receipts";
import { createClearanceToken, CLEARANCE_TOKEN_TTL_MS } from "@/lib/clearance-token";
import { __resetRateLimitStateForTests } from "@/lib/rate-limit";
import { GET } from "./route";

function get(token?: string, ip = "10.0.0.1") {
  const url = `http://localhost/api/receipts/clearance${token === undefined ? "" : `?token=${encodeURIComponent(token)}`}`;
  return new NextRequest(url, { headers: { "x-forwarded-for": ip } });
}

beforeEach(() => {
  vi.clearAllMocks();
  __resetRateLimitStateForTests();
  process.env.AUTH_SECRET = "test-secret";
  vi.mocked(buildClearanceReceiptPdf).mockResolvedValue({ pdfBytes: new Uint8Array([1]), receiptNumber: "CLR-2026-000001" } as any);
});

describe("GET /api/receipts/clearance", () => {
  it("returns the PDF for a valid token", async () => {
    const res = await GET(get(createClearanceToken("student_1")));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/pdf");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(buildClearanceReceiptPdf).toHaveBeenCalledWith("student_1");
  });

  it("400s without a token", async () => {
    expect((await GET(get())).status).toBe(400);
  });

  it("rejects a tampered token and never builds a PDF", async () => {
    const token = createClearanceToken("student_1");
    const res = await GET(get(token.slice(0, -3) + "abc"));
    expect(res.status).toBe(400);
    expect(buildClearanceReceiptPdf).not.toHaveBeenCalled();
  });

  it("returns 410 for an expired token", async () => {
    const token = createClearanceToken("student_1", Date.now() - CLEARANCE_TOKEN_TTL_MS - 1000);
    const res = await GET(get(token));
    expect(res.status).toBe(410);
    expect(buildClearanceReceiptPdf).not.toHaveBeenCalled();
  });

  it("404s when the clearance has since been removed", async () => {
    vi.mocked(buildClearanceReceiptPdf).mockResolvedValue(null);
    expect((await GET(get(createClearanceToken("student_1")))).status).toBe(404);
  });

  it("is rate limited per IP", async () => {
    const token = createClearanceToken("student_1");
    let last = 200;
    for (let i = 0; i < 101; i++) last = (await GET(get(token, "10.9.9.9"))).status;
    expect(last).toBe(429);
  });
});
