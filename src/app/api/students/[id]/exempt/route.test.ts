import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/db", () => ({
  prisma: {
    student: { findUniqueOrThrow: vi.fn(), update: vi.fn() },
    payment: { findFirst: vi.fn() },
    receipt: { updateMany: vi.fn() },
    $transaction: vi.fn(),
  },
}));
vi.mock("next-auth", () => ({ getServerSession: vi.fn() }));
vi.mock("@/lib/audit", () => ({ logAudit: vi.fn() }));
vi.mock("@/lib/receipts", () => ({
  issueClearanceReceipt: vi.fn(),
  sendClearanceEmail: vi.fn(),
}));

import { prisma } from "@/lib/db";
import { getServerSession } from "next-auth";
import { logAudit } from "@/lib/audit";
import { issueClearanceReceipt, sendClearanceEmail } from "@/lib/receipts";
import { POST, DELETE } from "./route";

const mockedPrisma = vi.mocked(prisma, true);
const mockedSession = vi.mocked(getServerSession);
const mockedIssue = vi.mocked(issueClearanceReceipt);
const mockedEmail = vi.mocked(sendClearanceEmail);
const mockedAudit = vi.mocked(logAudit);

const superAdmin = { id: "u_super", name: "S", email: "s@x.gh", role: "SUPER_ADMIN", departmentId: null };
const deptAdmin = { id: "u_dept", name: "D", email: "d@x.gh", role: "DEPARTMENT_ADMIN", departmentId: "dept_1" };

const student = {
  id: "student_1",
  departmentId: "dept_1",
  referenceNumber: "REF001",
  level: "L300",
  paymentStatus: "PENDING",
  isExempt: false,
  exemptReason: null,
};

function post(body: unknown = { reason: "Scholarship holder" }) {
  return new NextRequest("http://localhost/api/students/student_1/exempt", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}
const del = () => new NextRequest("http://localhost/api/students/student_1/exempt", { method: "DELETE" });
const ctx = { params: { id: "student_1" } };

beforeEach(() => {
  vi.clearAllMocks();
  mockedSession.mockResolvedValue({ user: superAdmin } as any);
  mockedPrisma.student.findUniqueOrThrow.mockResolvedValue(student as any);
  mockedPrisma.student.update.mockResolvedValue({} as any);
  mockedPrisma.payment.findFirst.mockResolvedValue(null);
  mockedPrisma.$transaction.mockResolvedValue([] as any);
  mockedIssue.mockResolvedValue({ receipt: { receiptNumber: "CLR-2026-000001" }, created: true } as any);
  mockedEmail.mockResolvedValue({ status: "SENT" });
});

describe("POST /api/students/[id]/exempt", () => {
  it("lets a super admin mark a student Dues Cleared, issues the receipt, emails and audits", async () => {
    const res = await POST(post(), ctx);
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(data.receiptNumber).toBe("CLR-2026-000001");
    expect(mockedPrisma.student.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ isExempt: true, exemptReason: "Scholarship holder", exemptedById: "u_super" }),
      })
    );
    expect(mockedEmail).toHaveBeenCalledWith("student_1");
    expect(mockedAudit).toHaveBeenCalledWith(expect.objectContaining({ action: "STUDENT_EXEMPTED", entityId: "student_1" }));
  });

  it("returns 403 for a department admin (e.g. the financial secretary)", async () => {
    mockedSession.mockResolvedValue({ user: deptAdmin } as any);
    const res = await POST(post(), ctx);
    expect(res.status).toBe(403);
    expect(mockedPrisma.student.update).not.toHaveBeenCalled();
  });

  it("returns 401 when not signed in", async () => {
    mockedSession.mockResolvedValue(null as any);
    expect((await POST(post(), ctx)).status).toBe(401);
  });

  it("requires a reason", async () => {
    const res = await POST(post({ reason: "  " }), ctx);
    expect(res.status).toBe(400);
    expect(mockedPrisma.student.update).not.toHaveBeenCalled();
  });

  it("refuses a Level 100 student", async () => {
    mockedPrisma.student.findUniqueOrThrow.mockResolvedValue({ ...student, level: "L100" } as any);
    const res = await POST(post(), ctx);
    expect(res.status).toBe(400);
    expect(mockedPrisma.student.update).not.toHaveBeenCalled();
  });

  it("refuses a student who has already paid", async () => {
    mockedPrisma.student.findUniqueOrThrow.mockResolvedValue({ ...student, paymentStatus: "SUCCESS" } as any);
    mockedPrisma.payment.findFirst.mockResolvedValue({ status: "SUCCESS" } as any);
    const res = await POST(post(), ctx);
    expect(res.status).toBe(409);
    expect(mockedPrisma.student.update).not.toHaveBeenCalled();
  });

  it("refuses a student with a payment in progress", async () => {
    mockedPrisma.payment.findFirst.mockResolvedValue({ status: "PENDING" } as any);
    const res = await POST(post(), ctx);
    expect(res.status).toBe(409);
    expect(mockedPrisma.student.update).not.toHaveBeenCalled();
  });

  it("refuses a student who is already cleared", async () => {
    mockedPrisma.student.findUniqueOrThrow.mockResolvedValue({ ...student, isExempt: true } as any);
    expect((await POST(post(), ctx)).status).toBe(409);
  });

  it("keeps the clearance and reports why when the email was skipped", async () => {
    mockedEmail.mockResolvedValue({ status: "SKIPPED", reason: "This student has no email address on file" });
    const res = await POST(post(), ctx);
    const data = await res.json();
    expect(res.status).toBe(200);
    expect(data.email).toEqual({ status: "SKIPPED", reason: "This student has no email address on file" });
  });

  it("rolls the clearance back if the receipt cannot be issued", async () => {
    mockedIssue.mockRejectedValue(new Error("boom"));
    const res = await POST(post(), ctx);
    expect(res.status).toBe(500);
    expect(mockedPrisma.student.update).toHaveBeenLastCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ isExempt: false }) })
    );
  });
});

describe("DELETE /api/students/[id]/exempt", () => {
  it("removes the clearance, voids the receipt and audits it", async () => {
    mockedPrisma.student.findUniqueOrThrow.mockResolvedValue({ ...student, isExempt: true, exemptReason: "Scholarship" } as any);
    const res = await DELETE(del(), ctx);

    expect(res.status).toBe(200);
    expect(mockedPrisma.$transaction).toHaveBeenCalled();
    expect(mockedPrisma.receipt.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ studentId: "student_1", kind: "CLEARANCE" }),
        data: { voidedAt: expect.any(Date) },
      })
    );
    expect(mockedAudit).toHaveBeenCalledWith(expect.objectContaining({ action: "EXEMPTION_REMOVED" }));
  });

  it("returns 403 for a department admin", async () => {
    mockedSession.mockResolvedValue({ user: deptAdmin } as any);
    expect((await DELETE(del(), ctx)).status).toBe(403);
  });

  it("returns 409 when the student is not cleared", async () => {
    expect((await DELETE(del(), ctx)).status).toBe(409);
  });
});
