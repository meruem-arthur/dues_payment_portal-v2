import type { Prisma } from "@prisma/client";

/**
 * The only payment fields the finance portal ever receives. Deliberately no
 * student name, phone, email or reference number - finance needs money, not
 * people.
 */
export const financePaymentSelect = {
  id: true,
  amount: true,
  currency: true,
  paymentType: true,
  status: true,
  paidAt: true,
  updatedAt: true,
  department: { select: { code: true } },
  academicSession: { select: { id: true, name: true } },
} satisfies Prisma.PaymentSelect;

export type FinancePaymentRow = Prisma.PaymentGetPayload<{ select: typeof financePaymentSelect }>;

export type FinancePaymentPayload = {
  id: string;
  amount: string; // decimal string, e.g. "50.00"
  currency: string;
  paymentType: string;
  status: string;
  paidAt: string | null;
  updatedAt: string;
  departmentCode: string;
  academicSession: { id: string; name: string };
};

export function toFinancePayload(row: FinancePaymentRow): FinancePaymentPayload {
  return {
    id: row.id,
    amount: row.amount.toFixed(2),
    currency: row.currency,
    paymentType: row.paymentType,
    status: row.status,
    paidAt: row.paidAt ? row.paidAt.toISOString() : null,
    updatedAt: row.updatedAt.toISOString(),
    departmentCode: row.department.code,
    academicSession: { id: row.academicSession.id, name: row.academicSession.name },
  };
}

// ---- pagination cursor: (updatedAt, id), so rows sharing a timestamp are never skipped

export function encodeCursor(updatedAt: Date, id: string): string {
  return Buffer.from(`${updatedAt.toISOString()}|${id}`, "utf8").toString("base64url");
}

export function decodeCursor(cursor: string): { updatedAt: Date; id: string } | null {
  try {
    const [iso, id] = Buffer.from(cursor, "base64url").toString("utf8").split("|");
    const updatedAt = new Date(iso);
    if (!id || Number.isNaN(updatedAt.getTime())) return null;
    return { updatedAt, id };
  } catch {
    return null;
  }
}
