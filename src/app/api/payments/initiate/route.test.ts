import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

// Mock prisma before importing the route, since the route module reads
// `prisma` off "@/lib/db" at call time.
vi.mock("@/lib/db", () => ({
  prisma: {
    department: { findUnique: vi.fn() },
    student: { findFirst: vi.fn(), create: vi.fn() },
    payment: { findFirst: vi.fn(), create: vi.fn() },
  },
}));

vi.mock("@/lib/payments/provider-factory", () => ({
  getPaymentProvider: vi.fn(),
}));

vi.mock("@/lib/audit", () => ({
  logAudit: vi.fn(),
}));

import { prisma } from "@/lib/db";
import { getPaymentProvider } from "@/lib/payments/provider-factory";
import { logAudit } from "@/lib/audit";
import { __resetRateLimitStateForTests } from "@/lib/rate-limit";
import { POST } from "./route";

const mockedPrisma = vi.mocked(prisma, true);
const mockedGetPaymentProvider = vi.mocked(getPaymentProvider);
const mockedLogAudit = vi.mocked(logAudit);

const baseDepartment = {
  id: "dept_1",
  slug: "ceramic-eng",
  code: "CE",
  status: "ACTIVE",
  academicSessionId: "session_1",
  fresherAmount: 150,
  continuingAmount: 100,
  paymentConfig: { secretKey: "sk_test_123", configValue: null, provider: "PAYSTACK", publicKey: "pk", webhookSecret: "wh", environment: "TEST" },
  academicSession: { id: "session_1", name: "2025/2026" },
};

const baseStudent = {
  id: "student_1",
  referenceNumber: "REF001",
  level: "L300",
  phone: "0551234567",
  paymentStatus: "PENDING",
};

function makeRequest(body: unknown, ip = "10.0.0.1") {
  return new NextRequest("http://localhost/api/payments/initiate", {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": ip },
    body: JSON.stringify(body),
  });
}

const validBody = {
  departmentSlug: "ceramic-eng",
  paymentType: "CONTINUING",
  referenceNumber: "REF001",
  phone: "0551234567",
};

beforeEach(() => {
  vi.clearAllMocks();
  __resetRateLimitStateForTests();

  mockedPrisma.department.findUnique.mockResolvedValue(baseDepartment as any);
  mockedPrisma.student.findFirst.mockResolvedValue(baseStudent as any);
  mockedPrisma.payment.findFirst.mockResolvedValue(null);
  mockedPrisma.payment.create.mockResolvedValue({ id: "payment_1" } as any);

  mockedGetPaymentProvider.mockReturnValue({
    name: "PAYSTACK",
    initiatePayment: vi.fn().mockResolvedValue({ authorizationUrl: "https://pay.example/abc", providerReference: "ref" }),
    verifyTransaction: vi.fn(),
    verifyWebhookSignature: vi.fn(),
    parseWebhookPayload: vi.fn(),
  } as any);
});

describe("POST /api/payments/initiate", () => {
  it("initiates payment for a valid, unpaid continuing student", async () => {
    const res = await POST(makeRequest(validBody));
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(data.authorizationUrl).toBe("https://pay.example/abc");
    expect(mockedPrisma.payment.create).toHaveBeenCalledTimes(1);
  });

  it("rejects a student who already has paymentStatus SUCCESS", async () => {
    mockedPrisma.student.findFirst.mockResolvedValue({ ...baseStudent, paymentStatus: "SUCCESS" } as any);

    const res = await POST(makeRequest(validBody));
    const data = await res.json();

    expect(res.status).toBe(409);
    expect(data.error).toMatch(/already paid/i);
    expect(mockedPrisma.payment.create).not.toHaveBeenCalled();
  });

  it("rejects a new attempt while a recent PENDING payment exists", async () => {
    mockedPrisma.payment.findFirst.mockResolvedValue({ id: "pending_payment" } as any);

    const res = await POST(makeRequest(validBody));
    const data = await res.json();

    expect(res.status).toBe(409);
    expect(data.error).toMatch(/already have a payment in progress/i);
    expect(mockedPrisma.payment.create).not.toHaveBeenCalled();
  });

  it("rejects a Level 100 (Fresher) student paying on the Continuing link", async () => {
    mockedPrisma.student.findFirst.mockResolvedValue({ ...baseStudent, level: "L100" } as any);

    const res = await POST(makeRequest({ ...validBody, paymentType: "CONTINUING" }));
    const data = await res.json();

    expect(res.status).toBe(409);
    expect(data.error).toMatch(/level 100/i);
    expect(mockedPrisma.payment.create).not.toHaveBeenCalled();
  });

  it("rejects a continuing student paying on the Fresher link", async () => {
    // baseStudent is L300 (continuing)
    const res = await POST(makeRequest({ ...validBody, paymentType: "FRESHER" }));
    const data = await res.json();

    expect(res.status).toBe(409);
    expect(data.error).toMatch(/continuing student/i);
    expect(mockedPrisma.payment.create).not.toHaveBeenCalled();
  });

  it("returns 404 when no student matches the reference number (continuing)", async () => {
    mockedPrisma.student.findFirst.mockResolvedValue(null);

    const res = await POST(makeRequest(validBody));
    expect(res.status).toBe(404);
    expect(mockedPrisma.payment.create).not.toHaveBeenCalled();
  });

  it("self-registers a fresher with no existing record and proceeds to payment", async () => {
    mockedPrisma.student.findFirst.mockResolvedValue(null);
    mockedPrisma.student.create.mockResolvedValue({
      id: "new_student_1",
      referenceNumber: "REF999",
      level: "L100",
      phone: "0551234567",
      paymentStatus: "PENDING",
    } as any);

    const res = await POST(
      makeRequest({
        ...validBody,
        paymentType: "FRESHER",
        referenceNumber: "REF999",
        fullName: "Ama Serwaa",
      })
    );
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(mockedPrisma.student.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          referenceNumber: "REF999",
          fullName: "Ama Serwaa",
          level: "L100",
        }),
      })
    );
    expect(mockedLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "STUDENT_SELF_REGISTERED" })
    );
    expect(data.authorizationUrl).toBe("https://pay.example/abc");
  });

  it("rejects a fresher self-registration attempt with no full name", async () => {
    mockedPrisma.student.findFirst.mockResolvedValue(null);

    const res = await POST(
      makeRequest({ ...validBody, paymentType: "FRESHER", referenceNumber: "REF999" })
    );
    const data = await res.json();

    expect(res.status).toBe(400);
    expect(data.error).toMatch(/full name/i);
    expect(mockedPrisma.student.create).not.toHaveBeenCalled();
  });

  it("does not require a full name for a FRESHER payment when the student already exists", async () => {
    // baseStudent is found (already registered), so no self-registration
    // path is taken - a resent/omitted fullName must not block this.
    mockedPrisma.student.findFirst.mockResolvedValue({ ...baseStudent, level: "L100" } as any);

    const res = await POST(makeRequest({ ...validBody, paymentType: "FRESHER" }));

    expect(res.status).toBe(200);
    expect(mockedPrisma.student.create).not.toHaveBeenCalled();
  });

  it("returns a friendly 409 when two fresher self-registrations race on the same reference number", async () => {
    mockedPrisma.student.findFirst.mockResolvedValue(null);
    const duplicateError: any = new Error("Unique constraint failed");
    duplicateError.code = "P2002";
    mockedPrisma.student.create.mockRejectedValue(duplicateError);

    const res = await POST(
      makeRequest({
        ...validBody,
        paymentType: "FRESHER",
        referenceNumber: "REF999",
        fullName: "Ama Serwaa",
      })
    );
    const data = await res.json();

    expect(res.status).toBe(409);
    expect(data.error).toMatch(/already exists/i);
    expect(mockedPrisma.payment.create).not.toHaveBeenCalled();
  });

  it("returns 410 for an archived department", async () => {
    mockedPrisma.department.findUnique.mockResolvedValue({ ...baseDepartment, status: "ARCHIVED" } as any);

    const res = await POST(makeRequest(validBody));
    expect(res.status).toBe(410);
  });

  it("never trusts a client-supplied amount - always uses department config", async () => {
    await POST(makeRequest({ ...validBody, amount: 1 }));

    const createArgs = mockedPrisma.payment.create.mock.calls[0][0];
    expect(createArgs.data.amount).toBe(baseDepartment.continuingAmount);
  });

  it("rate-limits repeated requests from the same IP", async () => {
    const ip = "10.0.0.99";
    // 8 requests are allowed (RATE_LIMIT_MAX_REQUESTS in route.ts).
    for (let i = 0; i < 8; i++) {
      const res = await POST(makeRequest(validBody, ip));
      expect(res.status).toBe(200);
    }
    const blocked = await POST(makeRequest(validBody, ip));
    const data = await blocked.json();
    expect(blocked.status).toBe(429);
    expect(data.error).toMatch(/too many/i);
  });

  it("does not rate-limit across different IPs", async () => {
    for (let i = 0; i < 8; i++) {
      await POST(makeRequest(validBody, "10.0.0.50"));
    }
    const res = await POST(makeRequest(validBody, "10.0.0.51"));
    expect(res.status).toBe(200);
  });
});
