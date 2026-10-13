import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/db", () => ({ prisma: { student: { findUnique: vi.fn() } } }));
vi.mock("next-auth", () => ({ getServerSession: vi.fn() }));
vi.mock("@/lib/audit", () => ({ logAudit: vi.fn() }));
vi.mock("@/lib/monitoring/capture-error", () => ({ captureError: vi.fn() }));
vi.mock("@/lib/students/delete-student", () => ({ deleteStudentWithPaymentAttempts: vi.fn() }));

import { prisma } from "@/lib/db";
import { getServerSession } from "next-auth";
import { logAudit } from "@/lib/audit";
import { deleteStudentWithPaymentAttempts } from "@/lib/students/delete-student";
import { DELETE } from "./route";

const session = vi.mocked(getServerSession);
const findUnique = vi.mocked(prisma.student.findUnique);
const del = vi.mocked(deleteStudentWithPaymentAttempts);

const superAdmin = { id: "u1", name: "S", email: "s@umat.edu.gh", role: "SUPER_ADMIN", departmentId: null };
const otherDept = { id: "u2", name: "D", email: "d@umat.edu.gh", role: "DEPARTMENT_ADMIN", departmentId: "dept_b" };
const student = { id: "s1", departmentId: "dept_a", referenceNumber: "9011111111" };

const call = () =>
  DELETE(new NextRequest("http://localhost/api/students/s1", { method: "DELETE" }), { params: { id: "s1" } });

beforeEach(() => {
  vi.resetAllMocks();
  session.mockResolvedValue({ user: superAdmin } as any);
  findUnique.mockResolvedValue(student as any);
});

describe("DELETE /api/students/[id]", () => {
  it("401 when not signed in", async () => {
    session.mockResolvedValue(null as any);
    expect((await call()).status).toBe(401);
    expect(del).not.toHaveBeenCalled();
  });

  it("404 when the student doesn't exist", async () => {
    findUnique.mockResolvedValue(null);
    expect((await call()).status).toBe(404);
  });

  it("403 for an admin of another department", async () => {
    session.mockResolvedValue({ user: otherDept } as any);
    expect((await call()).status).toBe(403);
    expect(del).not.toHaveBeenCalled();
  });

  it("409 with the real reason when deletion is refused", async () => {
    del.mockResolvedValue({ ok: false, code: "HAS_PAID", message: "nope" });
    const res = await call();
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "nope", code: "HAS_PAID" });
    expect(logAudit).not.toHaveBeenCalled();
  });

  it("200 and audit log on success", async () => {
    del.mockResolvedValue({ ok: true, deletedPayments: 2 });
    const res = await call();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true, deletedPayments: 2 });
    expect(logAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "STUDENT_DELETED", metadata: { referenceNumber: "9011111111", deletedPayments: 2 } })
    );
  });
});
