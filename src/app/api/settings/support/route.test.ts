import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/db", () => ({
  prisma: { supportSettings: { findUnique: vi.fn(), upsert: vi.fn() } },
}));
vi.mock("next-auth", () => ({ getServerSession: vi.fn() }));
vi.mock("@/lib/audit", () => ({ logAudit: vi.fn() }));

import { prisma } from "@/lib/db";
import { getServerSession } from "next-auth";
import { GET, PATCH } from "./route";

const mockedPrisma = vi.mocked(prisma, true);
const mockedSession = vi.mocked(getServerSession);

const superAdmin = { id: "u1", name: "S", email: "s@x.com", role: "SUPER_ADMIN", departmentId: null };
const deptAdmin = { id: "u2", name: "D", email: "d@x.com", role: "DEPARTMENT_ADMIN", departmentId: "dept_a" };

const patch = (body: unknown) =>
  new NextRequest("http://localhost/api/settings/support", {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

beforeEach(() => {
  vi.clearAllMocks();
  mockedPrisma.supportSettings.upsert.mockImplementation((async ({ update }: any) => ({ id: "singleton", ...update })) as any);
});

describe("/api/settings/support", () => {
  it("rejects unauthenticated and department-admin callers", async () => {
    mockedSession.mockResolvedValue(null);
    expect((await GET()).status).toBe(401);
    mockedSession.mockResolvedValue({ user: deptAdmin } as any);
    expect((await GET()).status).toBe(403);
    expect((await PATCH(patch({ email: "a@b.com", phone: "" }))).status).toBe(403);
    expect(mockedPrisma.supportSettings.upsert).not.toHaveBeenCalled();
  });

  it("lets the super admin save, and blank clears a channel", async () => {
    mockedSession.mockResolvedValue({ user: superAdmin } as any);
    const res = await PATCH(patch({ email: " support@umat.edu.gh ", phone: "" }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ email: "support@umat.edu.gh", phone: "" });
  });

  it("validates email and phone", async () => {
    mockedSession.mockResolvedValue({ user: superAdmin } as any);
    expect((await PATCH(patch({ email: "not-an-email", phone: "" }))).status).toBe(400);
    expect((await PATCH(patch({ email: "", phone: "123" }))).status).toBe(400);
  });
});
