import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/db", () => ({
  prisma: {
    department: { findUnique: vi.fn() },
    student: { findFirst: vi.fn() },
    supportSettings: { findUnique: vi.fn() },
    notificationLog: { create: vi.fn() },
  },
}));
vi.mock("@/lib/sms/provider-factory", () => ({ getSmsProvider: vi.fn() }));
vi.mock("@/lib/email/provider-factory", () => ({ getEmailProvider: vi.fn() }));
vi.mock("@/lib/crypto/field-encryption", () => ({
  decryptSmsApiKey: vi.fn((c: unknown) => c),
}));

import { prisma } from "@/lib/db";
import { getSmsProvider } from "@/lib/sms/provider-factory";
import { getEmailProvider } from "@/lib/email/provider-factory";
import { __resetRateLimitStateForTests } from "@/lib/rate-limit";
import { POST } from "./route";

const mockedPrisma = vi.mocked(prisma, true);
const smsSend = vi.fn();
const emailSend = vi.fn();

const department = {
  id: "dept_1",
  slug: "ceramic-eng",
  name: "Ceramic Engineering",
  code: "CE",
  status: "ACTIVE",
  academicSessionId: "session_1",
  smsConfig: { senderId: "UMAT", enabled: true, apiKey: "key", username: null },
};

const validBody = { departmentSlug: "ceramic-eng", referenceNumber: " 9012345 ", message: "Could not initiate payment" };

function makeRequest(body: unknown, ip = "10.0.0.1") {
  return new NextRequest("http://localhost/api/support/contact", {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": ip },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  __resetRateLimitStateForTests();
  mockedPrisma.department.findUnique.mockResolvedValue(department as any);
  mockedPrisma.student.findFirst.mockResolvedValue({ fullName: "Kofi Mensah", level: "L200", phone: "0551234567" } as any);
  mockedPrisma.supportSettings.findUnique.mockResolvedValue({ id: "singleton", email: "admin@example.com", phone: "0240000000" } as any);
  mockedPrisma.notificationLog.create.mockResolvedValue({} as any);
  smsSend.mockResolvedValue({ success: true });
  emailSend.mockResolvedValue({ success: true });
  vi.mocked(getSmsProvider).mockReturnValue({ send: smsSend } as any);
  vi.mocked(getEmailProvider).mockReturnValue({ send: emailSend } as any);
});

describe("POST /api/support/contact", () => {
  it("sends both email and SMS to the system-wide support contact", async () => {
    const res = await POST(makeRequest(validBody));
    expect(res.status).toBe(200);

    expect(mockedPrisma.student.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ referenceNumber: "9012345" }) })
    );
    expect(emailSend).toHaveBeenCalledWith(
      expect.objectContaining({ to: "admin@example.com", body: expect.stringContaining("Could not initiate payment") })
    );
    expect(emailSend.mock.calls[0][0].body).toContain("Kofi Mensah");
    // SMS uses the department's own sender and credentials.
    expect(smsSend).toHaveBeenCalledWith(
      expect.objectContaining({ to: "0240000000", senderId: "UMAT", message: expect.stringContaining("9012345") }),
      { apiKey: "key", username: null }
    );
  });

  it("still succeeds by email when the department has no SMS configured", async () => {
    mockedPrisma.department.findUnique.mockResolvedValue({ ...department, smsConfig: null } as any);
    const res = await POST(makeRequest(validBody));
    expect(res.status).toBe(200);
    expect(smsSend).not.toHaveBeenCalled();
    expect(emailSend).toHaveBeenCalledTimes(1);
  });

  it("still succeeds by SMS when email fails, and logs the failure", async () => {
    emailSend.mockResolvedValue({ success: false, error: "Brevo down" });
    const res = await POST(makeRequest(validBody));
    expect(res.status).toBe(200);
    expect(mockedPrisma.notificationLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ channel: "EMAIL", status: "FAILED", errorMessage: "Brevo down" }),
    });
  });

  it("does not claim success when every channel fails", async () => {
    emailSend.mockResolvedValue({ success: false, error: "x" });
    smsSend.mockRejectedValue(new Error("network"));
    const res = await POST(makeRequest(validBody));
    expect(res.status).toBe(502);
  });

  it("returns 503 when no support contact has been configured", async () => {
    mockedPrisma.supportSettings.findUnique.mockResolvedValue(null);
    const res = await POST(makeRequest(validBody));
    expect(res.status).toBe(503);
    expect(emailSend).not.toHaveBeenCalled();
    expect(smsSend).not.toHaveBeenCalled();
  });

  it("notes when the reference number matches no student", async () => {
    mockedPrisma.student.findFirst.mockResolvedValue(null);
    const res = await POST(makeRequest(validBody));
    expect(res.status).toBe(200);
    expect(emailSend.mock.calls[0][0].body).toContain("no student with this reference number");
  });

  it("rejects missing or too-short input and unknown departments", async () => {
    expect((await POST(makeRequest({ ...validBody, message: "hi" }))).status).toBe(400);
    expect((await POST(makeRequest({ ...validBody, referenceNumber: "  " }))).status).toBe(400);
    mockedPrisma.department.findUnique.mockResolvedValue(null);
    expect((await POST(makeRequest(validBody))).status).toBe(404);
  });

  it("rate-limits per IP", async () => {
    for (let i = 0; i < 10; i++) {
      expect((await POST(makeRequest(validBody, "10.9.9.9"))).status).toBe(200);
    }
    const blocked = await POST(makeRequest(validBody, "10.9.9.9"));
    expect(blocked.status).toBe(429);
    expect((await POST(makeRequest(validBody, "10.8.8.8"))).status).toBe(200);
  });
});
