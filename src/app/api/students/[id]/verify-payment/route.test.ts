import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/db", () => ({
  prisma: {
    student: { findUniqueOrThrow: vi.fn() },
    payment: { findFirst: vi.fn() },
  },
}));
vi.mock("@/lib/authorization", () => {
  class UnauthorizedError extends Error {}
  class ForbiddenError extends Error {}
  return { requireDepartmentAccess: vi.fn(), UnauthorizedError, ForbiddenError };
});
vi.mock("@/lib/payments/reconcile", () => ({ reconcilePayment: vi.fn() }));
vi.mock("@/lib/monitoring/capture-error", () => ({ captureError: vi.fn() }));

import { prisma } from "@/lib/db";
import { requireDepartmentAccess, ForbiddenError, UnauthorizedError } from "@/lib/authorization";
import { reconcilePayment } from "@/lib/payments/reconcile";
import { POST } from "./route";

const mockedPrisma = vi.mocked(prisma, true);
const mockedAccess = vi.mocked(requireDepartmentAccess);
const mockedReconcile = vi.mocked(reconcilePayment);

const params = { params: { id: "student_1" } };
const req = () => new NextRequest("http://localhost/api/students/student_1/verify-payment", { method: "POST" });

beforeEach(() => {
  vi.clearAllMocks();
  mockedPrisma.student.findUniqueOrThrow.mockResolvedValue({ id: "student_1", departmentId: "dept_1" } as any);
  mockedAccess.mockResolvedValue({ id: "user_1" } as any);
  mockedPrisma.payment.findFirst.mockResolvedValue({ id: "payment_1" } as any);
  mockedReconcile.mockResolvedValue({ outcome: "CONFIRMED", receiptNumber: "REC-2026-000009" });
});

describe("POST /api/students/[id]/verify-payment", () => {
  it("checks the student's latest pending payment and returns the outcome", async () => {
    const res = await POST(req(), params);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ outcome: "CONFIRMED", receiptNumber: "REC-2026-000009" });
    expect(mockedPrisma.payment.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { studentId: "student_1", status: "PENDING" }, orderBy: { createdAt: "desc" } })
    );
    expect(mockedReconcile).toHaveBeenCalledWith("payment_1", { source: "admin", actorUserId: "user_1" });
  });

  it("checks access against the STUDENT's department before doing anything", async () => {
    await POST(req(), params);
    expect(mockedAccess).toHaveBeenCalledWith("dept_1");
  });

  it("404s when the student has no pending payment", async () => {
    mockedPrisma.payment.findFirst.mockResolvedValue(null);

    const res = await POST(req(), params);

    expect(res.status).toBe(404);
    expect(mockedReconcile).not.toHaveBeenCalled();
  });

  it("403s for an admin from another department, without calling the provider", async () => {
    mockedAccess.mockRejectedValue(new ForbiddenError("Forbidden"));

    const res = await POST(req(), params);

    expect(res.status).toBe(403);
    expect(mockedReconcile).not.toHaveBeenCalled();
  });

  it("401s when not signed in", async () => {
    mockedAccess.mockRejectedValue(new UnauthorizedError("Unauthorized"));
    expect((await POST(req(), params)).status).toBe(401);
  });
});
