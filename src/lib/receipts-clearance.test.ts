import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/db", () => ({
  prisma: {
    student: { findUniqueOrThrow: vi.fn(), findUnique: vi.fn() },
    receipt: { count: vi.fn(), findFirst: vi.fn(), create: vi.fn(), update: vi.fn() },
    notificationLog: { create: vi.fn() },
  },
}));
vi.mock("@/lib/sms/provider-factory", () => ({ getSmsProvider: vi.fn() }));
vi.mock("@/lib/email/provider-factory", () => ({ getEmailProvider: vi.fn() }));

import { prisma } from "@/lib/db";
import { getSmsProvider } from "@/lib/sms/provider-factory";
import { getEmailProvider } from "@/lib/email/provider-factory";
import { generateReceiptNumber, issueClearanceReceipt, sendClearanceEmail } from "@/lib/receipts";

const mockedPrisma = vi.mocked(prisma, true);

const activeReceipt = { id: "r1", receiptNumber: "CLR-2026-000001", kind: "CLEARANCE", voidedAt: null, issuedAt: new Date("2026-09-30T10:00:00Z") };

const clearedStudent = (over: Record<string, unknown> = {}) => ({
  id: "student_1",
  fullName: "Kwame Mensah",
  referenceNumber: "REF001",
  level: "L300",
  email: "kwame@example.com",
  isExempt: true,
  departmentId: "dept_1",
  academicSession: { name: "2026/2027" },
  department: {
    name: "Ceramic Engineering",
    logoUrl: null,
    financialSecretaryName: null,
    financialSecretarySignatureUrl: null,
    presidentName: null,
    presidentSignatureUrl: null,
    emailConfig: { enabled: true, fromAddress: "dues@umat.edu.gh", emailTemplate: "Dear {name}, your payment of GHS {amount} ..." },
  },
  receipts: [activeReceipt],
  ...over,
});

let emailSend: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.clearAllMocks();
  mockedPrisma.notificationLog.create.mockResolvedValue({} as any);
  emailSend = vi.fn().mockResolvedValue({ success: true });
  vi.mocked(getEmailProvider).mockReturnValue({ send: emailSend } as any);
});

describe("generateReceiptNumber", () => {
  it("defaults to the REC series", async () => {
    mockedPrisma.receipt.count.mockResolvedValue(5);
    const year = new Date().getFullYear();
    expect(await generateReceiptNumber()).toBe(`REC-${year}-000006`);
    expect(mockedPrisma.receipt.count).toHaveBeenCalledWith({ where: { receiptNumber: { startsWith: `REC-${year}-` } } });
  });

  it("numbers clearance receipts in their own CLR series", async () => {
    mockedPrisma.receipt.count.mockResolvedValue(0);
    const year = new Date().getFullYear();
    expect(await generateReceiptNumber("CLR")).toBe(`CLR-${year}-000001`);
    expect(mockedPrisma.receipt.count).toHaveBeenCalledWith({ where: { receiptNumber: { startsWith: `CLR-${year}-` } } });
  });
});

describe("issueClearanceReceipt", () => {
  it("refuses a student who is not cleared", async () => {
    mockedPrisma.student.findUniqueOrThrow.mockResolvedValue({ id: "student_1", isExempt: false } as any);
    await expect(issueClearanceReceipt("student_1")).rejects.toThrow(/not marked Dues Cleared/);
    expect(mockedPrisma.receipt.create).not.toHaveBeenCalled();
  });

  it("creates a CLEARANCE receipt with no payment", async () => {
    mockedPrisma.student.findUniqueOrThrow.mockResolvedValue({ id: "student_1", isExempt: true, departmentId: "dept_1" } as any);
    mockedPrisma.receipt.findFirst.mockResolvedValue(null);
    mockedPrisma.receipt.count.mockResolvedValue(0);
    mockedPrisma.receipt.create.mockResolvedValue(activeReceipt as any);

    const result = await issueClearanceReceipt("student_1");

    expect(result.created).toBe(true);
    const data = mockedPrisma.receipt.create.mock.calls[0][0].data as any;
    expect(data.kind).toBe("CLEARANCE");
    expect(data.receiptNumber).toMatch(/^CLR-\d{4}-000001$/);
    expect(data.paymentId).toBeUndefined();
  });

  it("is idempotent while the clearance receipt is active", async () => {
    mockedPrisma.student.findUniqueOrThrow.mockResolvedValue({ id: "student_1", isExempt: true } as any);
    mockedPrisma.receipt.findFirst.mockResolvedValue(activeReceipt as any);

    const result = await issueClearanceReceipt("student_1");
    expect(result).toEqual({ receipt: activeReceipt, created: false });
    expect(mockedPrisma.receipt.create).not.toHaveBeenCalled();
  });

  it("revives the same voided receipt instead of creating a second one", async () => {
    mockedPrisma.student.findUniqueOrThrow.mockResolvedValue({ id: "student_1", isExempt: true } as any);
    mockedPrisma.receipt.findFirst.mockResolvedValue({ ...activeReceipt, voidedAt: new Date() } as any);
    mockedPrisma.receipt.update.mockResolvedValue(activeReceipt as any);

    const result = await issueClearanceReceipt("student_1");
    expect(result.created).toBe(true);
    expect(mockedPrisma.receipt.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "r1" }, data: expect.objectContaining({ voidedAt: null }) })
    );
    expect(mockedPrisma.receipt.create).not.toHaveBeenCalled();
  });
});

describe("sendClearanceEmail", () => {
  it("sends its own wording with the PDF attached, and never texts", async () => {
    mockedPrisma.student.findUnique.mockResolvedValue(clearedStudent() as any);

    const result = await sendClearanceEmail("student_1");

    expect(result).toEqual({ status: "SENT" });
    const sent = emailSend.mock.calls[0][0];
    expect(sent.to).toBe("kwame@example.com");
    expect(sent.subject).toContain("CLR-2026-000001");
    expect(sent.body).toContain("cleared");
    expect(sent.body).not.toContain("payment of");
    expect(sent.attachments?.[0]?.filename).toBe("CLR-2026-000001.pdf");
    expect(getSmsProvider).not.toHaveBeenCalled();
  });

  it("skips, with a reason, when the student has no email on file", async () => {
    mockedPrisma.student.findUnique.mockResolvedValue(clearedStudent({ email: null }) as any);
    const result = await sendClearanceEmail("student_1");
    expect(result.status).toBe("SKIPPED");
    expect(result.reason).toMatch(/no email/i);
    expect(emailSend).not.toHaveBeenCalled();
  });

  it("skips, with a reason, when the department's email setting is off", async () => {
    const s = clearedStudent();
    (s.department.emailConfig as any).enabled = false;
    mockedPrisma.student.findUnique.mockResolvedValue(s as any);
    const result = await sendClearanceEmail("student_1");
    expect(result.status).toBe("SKIPPED");
    expect(result.reason).toMatch(/turned off/i);
    expect(emailSend).not.toHaveBeenCalled();
  });

  it("skips when the clearance receipt has been voided", async () => {
    mockedPrisma.student.findUnique.mockResolvedValue(
      clearedStudent({ receipts: [{ ...activeReceipt, voidedAt: new Date() }] }) as any
    );
    expect((await sendClearanceEmail("student_1")).status).toBe("SKIPPED");
    expect(emailSend).not.toHaveBeenCalled();
  });

  it("reports FAILED with the provider's error and logs it", async () => {
    mockedPrisma.student.findUnique.mockResolvedValue(clearedStudent() as any);
    emailSend.mockResolvedValue({ success: false, error: "Brevo rejected the sender" });

    const result = await sendClearanceEmail("student_1");

    expect(result).toEqual({ status: "FAILED", reason: "Brevo rejected the sender" });
    expect(mockedPrisma.notificationLog.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: "FAILED", channel: "EMAIL" }) })
    );
  });
});
