import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/db", () => ({
  prisma: {
    payment: { findMany: vi.fn(), groupBy: vi.fn(), findUnique: vi.fn() },
    user: { findUnique: vi.fn() },
  },
}));
vi.mock("next-auth", () => ({ getServerSession: vi.fn() }));
vi.mock("@/lib/audit", () => ({ logAudit: vi.fn() }));

import { prisma } from "@/lib/db";
import { getServerSession } from "next-auth";
import { GET as getPayments } from "@/app/api/finance/payments/route";
import { GET as getSummary } from "@/app/api/finance/summary/route";
import { GET as getSso } from "@/app/api/finance/sso/route";
import { verifySsoToken } from "@/lib/finance/signing";
import { encodeCursor } from "@/lib/finance/payload";

const mockedPrisma = vi.mocked(prisma, true);
const mockedSession = vi.mocked(getServerSession);

const ENV = {
  FINANCE_DEPARTMENT_CODE: "GESA",
  FINANCE_API_KEY: "api-key-123",
  FINANCE_PUSH_TOKEN: "push-token-456",
  FINANCE_PORTAL_URL: "https://finance.example.com/",
};
const saved: Record<string, string | undefined> = {};

function req(path: string, headers: Record<string, string> = {}) {
  return new NextRequest(`https://dues.example.com${path}`, { headers });
}
const authed = { authorization: "Bearer api-key-123" };

function row(id: string, updatedAt: string, status = "SUCCESS") {
  return {
    id,
    amount: { toFixed: () => "50.00" },
    currency: "GHS",
    paymentType: "FRESHER",
    status,
    paidAt: new Date(updatedAt),
    updatedAt: new Date(updatedAt),
    department: { code: "GESA" },
    academicSession: { id: "s1", name: "2026/2027" },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  for (const [k, v] of Object.entries(ENV)) {
    saved[k] = process.env[k];
    process.env[k] = v;
  }
});
afterEach(() => {
  for (const k of Object.keys(ENV)) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe("GET /api/finance/payments", () => {
  it("is closed when the integration is not configured", async () => {
    delete process.env.FINANCE_API_KEY;
    expect((await getPayments(req("/api/finance/payments", authed))).status).toBe(503);
  });

  it("rejects missing and wrong keys", async () => {
    expect((await getPayments(req("/api/finance/payments"))).status).toBe(401);
    expect((await getPayments(req("/api/finance/payments", { authorization: "Bearer nope" }))).status).toBe(401);
    expect(mockedPrisma.payment.findMany).not.toHaveBeenCalled();
  });

  it("returns only the finance department's money payments, without student data", async () => {
    mockedPrisma.payment.findMany.mockResolvedValue([row("p1", "2026-10-01T10:00:00Z")] as any);
    const res = await getPayments(req("/api/finance/payments", authed));
    const body = await res.json();

    const args = mockedPrisma.payment.findMany.mock.calls[0][0] as any;
    expect(args.where.department).toEqual({ code: { equals: "GESA", mode: "insensitive" } });
    expect(args.where.status).toEqual({ in: ["SUCCESS", "REFUNDED"] });
    expect(body.payments[0]).toMatchObject({ id: "p1", amount: "50.00", departmentCode: "GESA" });
    expect(JSON.stringify(body)).not.toMatch(/student|phone|email/i);
    expect(body.hasMore).toBe(false);
  });

  it("pages with a (updatedAt, id) cursor and reports hasMore", async () => {
    mockedPrisma.payment.findMany.mockResolvedValue([
      row("p1", "2026-10-01T10:00:00Z"),
      row("p2", "2026-10-01T10:00:00Z"),
      row("p3", "2026-10-02T10:00:00Z"),
    ] as any);
    const body = await (await getPayments(req("/api/finance/payments?limit=2", authed))).json();
    expect(body.payments.map((p: any) => p.id)).toEqual(["p1", "p2"]);
    expect(body.hasMore).toBe(true);
    expect(body.nextCursor).toBe(encodeCursor(new Date("2026-10-01T10:00:00Z"), "p2"));

    mockedPrisma.payment.findMany.mockResolvedValue([] as any);
    await getPayments(req(`/api/finance/payments?cursor=${body.nextCursor}`, authed));
    const args = mockedPrisma.payment.findMany.mock.calls[1][0] as any;
    expect(args.where.OR).toEqual([
      { updatedAt: { gt: new Date("2026-10-01T10:00:00Z") } },
      { updatedAt: new Date("2026-10-01T10:00:00Z"), id: { gt: "p2" } },
    ]);
  });

  it("rejects a malformed cursor", async () => {
    expect((await getPayments(req("/api/finance/payments?cursor=@@@", authed))).status).toBe(400);
  });
});

describe("GET /api/finance/summary", () => {
  it("requires the key and returns totals", async () => {
    expect((await getSummary(req("/api/finance/summary"))).status).toBe(401);
    mockedPrisma.payment.groupBy.mockResolvedValue([
      { status: "SUCCESS", _sum: { amount: { toString: () => "1500.00" } }, _count: { _all: 30 } },
    ] as any);
    const body = await (await getSummary(req("/api/finance/summary", authed))).json();
    expect(body.success).toEqual({ count: 30, total: "1500.00" });
    expect(body.refunded).toEqual({ count: 0, total: "0" });
  });
});

describe("GET /api/finance/sso", () => {
  const user = (over: object) => ({
    id: "u1", name: "Ama", email: "ama@x.com", role: "DEPARTMENT_ADMIN", status: "ACTIVE",
    department: { code: "GESA" }, ...over,
  });

  it("sends signed-out visitors to login and back", async () => {
    mockedSession.mockResolvedValue(null);
    const res = await getSso(req("/api/finance/sso"));
    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toContain("/login?callbackUrl=%2Fapi%2Ffinance%2Fsso");
  });

  it("refuses an admin of another department", async () => {
    mockedSession.mockResolvedValue({ user: { id: "u1" } } as any);
    mockedPrisma.user.findUnique.mockResolvedValue(user({ department: { code: "MINING" } }) as any);
    expect((await getSso(req("/api/finance/sso"))).status).toBe(403);
  });

  it("refuses a deactivated account", async () => {
    mockedSession.mockResolvedValue({ user: { id: "u1" } } as any);
    mockedPrisma.user.findUnique.mockResolvedValue(user({ status: "SUSPENDED" }) as any);
    expect((await getSso(req("/api/finance/sso"))).status).toBe(403);
  });

  it("hands the finance department's admin over with a valid token in the URL fragment", async () => {
    mockedSession.mockResolvedValue({ user: { id: "u1" } } as any);
    mockedPrisma.user.findUnique.mockResolvedValue(user({}) as any);
    const res = await getSso(req("/api/finance/sso"));
    const location = res.headers.get("location") as string;
    expect(location.startsWith("https://finance.example.com/auth/sso#token=")).toBe(true);
    const claims = verifySsoToken(location.split("#token=")[1], "push-token-456");
    expect(claims).toMatchObject({ sub: "u1", role: "DEPARTMENT_ADMIN", departmentCode: "GESA" });
  });

  it("lets a super admin through", async () => {
    mockedSession.mockResolvedValue({ user: { id: "u9" } } as any);
    mockedPrisma.user.findUnique.mockResolvedValue(user({ id: "u9", role: "SUPER_ADMIN", department: null }) as any);
    expect((await getSso(req("/api/finance/sso"))).headers.get("location")).toContain("/auth/sso#token=");
  });
});
