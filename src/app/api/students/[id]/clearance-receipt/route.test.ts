import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/db", () => ({ prisma: { student: { findUniqueOrThrow: vi.fn() } } }));
vi.mock("next-auth", () => ({ getServerSession: vi.fn() }));
vi.mock("@/lib/receipts", () => ({ buildClearanceReceiptPdf: vi.fn() }));

import { prisma } from "@/lib/db";
import { getServerSession } from "next-auth";
import { buildClearanceReceiptPdf } from "@/lib/receipts";
import { GET } from "./route";

const req = () => new NextRequest("http://localhost/api/students/student_1/clearance-receipt");
const ctx = { params: { id: "student_1" } };

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(prisma, true).student.findUniqueOrThrow.mockResolvedValue({ id: "student_1" } as any);
});

describe("GET /api/students/[id]/clearance-receipt", () => {
  it("returns the PDF to a super admin", async () => {
    vi.mocked(getServerSession).mockResolvedValue({ user: { id: "u", role: "SUPER_ADMIN", departmentId: null } } as any);
    vi.mocked(buildClearanceReceiptPdf).mockResolvedValue({ pdfBytes: new Uint8Array([1, 2, 3]), receiptNumber: "CLR-2026-000001" } as any);
    const res = await GET(req(), ctx);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/pdf");
  });

  it("returns 403 for a department admin", async () => {
    vi.mocked(getServerSession).mockResolvedValue({ user: { id: "u", role: "DEPARTMENT_ADMIN", departmentId: "dept_1" } } as any);
    expect((await GET(req(), ctx)).status).toBe(403);
    expect(buildClearanceReceiptPdf).not.toHaveBeenCalled();
  });

  it("returns 404 when there is no active clearance receipt", async () => {
    vi.mocked(getServerSession).mockResolvedValue({ user: { id: "u", role: "SUPER_ADMIN", departmentId: null } } as any);
    vi.mocked(buildClearanceReceiptPdf).mockResolvedValue(null);
    expect((await GET(req(), ctx)).status).toBe(404);
  });
});
