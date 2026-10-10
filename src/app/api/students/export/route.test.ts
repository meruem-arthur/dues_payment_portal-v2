import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/db", () => ({
  prisma: {
    department: { findUnique: vi.fn() },
    student: { findMany: vi.fn() },
  },
}));
vi.mock("next-auth", () => ({ getServerSession: vi.fn() }));
vi.mock("@/lib/audit", () => ({ logAudit: vi.fn() }));

import { prisma } from "@/lib/db";
import { getServerSession } from "next-auth";
import { logAudit } from "@/lib/audit";
import { GET } from "./route";

const mockedPrisma = vi.mocked(prisma, true);
const mockedSession = vi.mocked(getServerSession);

const superAdmin = { id: "u1", name: "Super", email: "s@umat.edu.gh", role: "SUPER_ADMIN", departmentId: null };
const deptAdmin = { id: "u2", name: "Dept", email: "d@umat.edu.gh", role: "DEPARTMENT_ADMIN", departmentId: "dept_a" };

function get(query: string) {
  return GET(new NextRequest(`http://localhost/api/students/export?${query}`));
}

const row = (o: Partial<any> = {}) => ({
  fullName: "Ama Serwaa", referenceNumber: "REF1", studentIndexNo: null, level: "L200",
  phone: "0551234567", email: "ama@example.com", paymentStatus: "SUCCESS", isExempt: false,
  registrationSource: "ADMIN", ...o,
});

beforeEach(() => {
  vi.clearAllMocks();
  mockedSession.mockResolvedValue({ user: superAdmin } as any);
  mockedPrisma.department.findUnique.mockResolvedValue({ id: "dept_a", name: "Geomatic Engineering" } as any);
  mockedPrisma.student.findMany.mockResolvedValue([row()] as any);
});

describe("GET /api/students/export", () => {
  it("is super admin only", async () => {
    mockedSession.mockResolvedValue({ user: deptAdmin } as any);
    const res = await get("departmentId=dept_a");
    expect(res.status).toBe(403);
    expect(mockedPrisma.student.findMany).not.toHaveBeenCalled();
  });

  it("rejects unauthenticated callers", async () => {
    mockedSession.mockResolvedValue(null as any);
    expect((await get("departmentId=dept_a")).status).toBe(401);
  });

  it("requires a departmentId so it can never span all departments", async () => {
    const res = await get("level=L200");
    expect(res.status).toBe(400);
    expect(mockedPrisma.student.findMany).not.toHaveBeenCalled();
  });

  it("scopes to the selected department and applies level + paid filters, with no row cap", async () => {
    const res = await get("departmentId=dept_a&level=L200&paymentStatus=SUCCESS");
    expect(res.status).toBe(200);
    const args = mockedPrisma.student.findMany.mock.calls[0][0] as any;
    expect(args.where).toMatchObject({ departmentId: "dept_a", level: "L200", paymentStatus: "SUCCESS" });
    expect(args.take).toBeUndefined();
    expect(res.headers.get("Content-Disposition")).toMatch(/students_geomatic-engineering_l200_paid_\d{4}-\d{2}-\d{2}\.csv/);
  });

  it("excludes Dues Cleared students from the unpaid export", async () => {
    await get("departmentId=dept_a&paymentStatus=PENDING");
    const args = mockedPrisma.student.findMany.mock.calls[0][0] as any;
    expect(args.where).toMatchObject({ paymentStatus: "PENDING", isExempt: false });
  });

  it("does not hide cleared students from an all-students export", async () => {
    await get("departmentId=dept_a");
    const args = mockedPrisma.student.findMany.mock.calls[0][0] as any;
    expect(args.where).not.toHaveProperty("isExempt");
  });

  it("lets an explicit exempt filter win over the unpaid rule", async () => {
    await get("departmentId=dept_a&paymentStatus=PENDING&exempt=true");
    const args = mockedPrisma.student.findMany.mock.calls[0][0] as any;
    expect(args.where.isExempt).toBe(true);
  });

  it("returns CSV with a header and labels cleared students as Dues Cleared", async () => {
    mockedPrisma.student.findMany.mockResolvedValue([row({ paymentStatus: "PENDING", isExempt: true })] as any);
    const res = await get("departmentId=dept_a");
    const text = await res.text();
    expect(res.headers.get("Content-Type")).toMatch(/text\/csv/);
    expect(text).toContain("name,reference_number,student_id,level,phone,email,payment_status,registered_via");
    expect(text).toContain("Dues Cleared");
    expect(text).not.toContain("Unpaid");
  });

  it("still returns a header row when nothing matches", async () => {
    mockedPrisma.student.findMany.mockResolvedValue([] as any);
    const text = await (await get("departmentId=dept_a")).text();
    expect(text).toContain("name,reference_number");
  });

  it("writes an audit record with the filters and row count", async () => {
    await get("departmentId=dept_a&level=L300");
    expect(vi.mocked(logAudit)).toHaveBeenCalledWith(
      expect.objectContaining({ action: "STUDENTS_EXPORTED", departmentId: "dept_a", metadata: expect.objectContaining({ rowCount: 1, level: "L300" }) })
    );
  });
});
