import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/db", () => ({
  prisma: {
    department: { findUnique: vi.fn() },
    student: { groupBy: vi.fn() },
    payment: { groupBy: vi.fn(), findMany: vi.fn() },
  },
}));
vi.mock("next-auth", () => ({ getServerSession: vi.fn() }));

import { prisma } from "@/lib/db";
import { getServerSession } from "next-auth";
import { GET } from "./route";

const mockedPrisma = vi.mocked(prisma, true);

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getServerSession).mockResolvedValue({ user: { id: "u", role: "SUPER_ADMIN", departmentId: null } } as any);
  mockedPrisma.department.findUnique.mockResolvedValue({
    id: "dept_1", name: "Ceramic", code: "CE", fresherAmount: 150, continuingAmount: 100,
  } as any);
  mockedPrisma.payment.groupBy.mockResolvedValue([]);
  mockedPrisma.payment.findMany.mockResolvedValue([]);
});

describe("GET /api/departments/[id]/stats - exempt students", () => {
  it("keeps the full headcount but excludes exempt students from expected total and pending", async () => {
    mockedPrisma.student.groupBy.mockResolvedValue([
      { level: "L100", paymentStatus: "PENDING", isExempt: false, _count: { _all: 2 } },
      { level: "L200", paymentStatus: "SUCCESS", isExempt: false, _count: { _all: 3 } },
      { level: "L200", paymentStatus: "PENDING", isExempt: false, _count: { _all: 1 } },
      { level: "L200", paymentStatus: "PENDING", isExempt: true, _count: { _all: 2 } },
      { level: "L300", paymentStatus: "PENDING", isExempt: true, _count: { _all: 1 } },
    ] as any);

    const res = await GET(new NextRequest("http://localhost/api/departments/dept_1/stats"), { params: { id: "dept_1" } });
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(data.totals.totalStudents).toBe(9); // everyone, exempt included
    expect(data.totals.exemptStudents).toBe(3);
    expect(data.totals.paidStudents).toBe(3);
    expect(data.totals.pendingStudents).toBe(3); // 2 L100 + 1 L200, exempt not counted
    // L100: 2 x 150, L200: (6 - 2 exempt) x 100, L300: (1 - 1 exempt) x 100
    expect(data.totals.expectedTotal).toBe(2 * 150 + 4 * 100);

    const l200 = data.levelBreakdown.find((l: any) => l.level === "L200");
    expect(l200).toMatchObject({ total: 6, paid: 3, pending: 1, exempt: 2 });
    expect(data.levelBreakdown.find((l: any) => l.level === "L300").exempt).toBe(1);
  });
});
