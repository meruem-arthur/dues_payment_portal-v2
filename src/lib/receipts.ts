import { prisma } from "@/lib/db";
import { getSmsProvider } from "@/lib/sms/provider-factory";
import { getEmailProvider } from "@/lib/email/provider-factory";
import { decryptSmsApiKey } from "@/lib/crypto/field-encryption";
import { captureError } from "@/lib/monitoring/capture-error";
import { generateReceiptPdf } from "@/lib/receipts-pdf";

/**
 * Generates a receipt number in the form <prefix>-<year>-<zero-padded sequence>.
 * Payment receipts use the default REC prefix; clearance receipts use CLR,
 * which is its own series (CLR-2026-000001) counted independently.
 * Uses a transaction-safe count query; for high concurrency this could be
 * swapped for a DB sequence, but is sufficient for department-dues volumes.
 */
export async function generateReceiptNumber(prefix: string = "REC"): Promise<string> {
  const year = new Date().getFullYear();
  const count = await prisma.receipt.count({
    where: { receiptNumber: { startsWith: `${prefix}-${year}-` } },
  });
  const next = (count + 1).toString().padStart(6, "0");
  return `${prefix}-${year}-${next}`;
}

/**
 * Creates the receipt for a SUCCESS payment and marks the student PAID.
 * Database work only - no network calls - so it is fast enough to run
 * inside the webhook request. Sending SMS/email is a separate step
 * (sendReceiptNotifications) that callers run in the background.
 *
 * Safe to call more than once and from several places at once (the
 * webhook, the status-page verify, the admin "Check payment" button and
 * the cron job can all confirm the same payment): exactly one caller
 * creates the receipt (`created: true`), everyone else gets the existing
 * one back (`created: false`). Only the creator should send notifications,
 * which is what stops a racing webhook + reconcile from texting a student
 * twice.
 */
export async function issueReceipt(paymentId: string) {
  const payment = await prisma.payment.findUniqueOrThrow({ where: { id: paymentId } });

  if (payment.status !== "SUCCESS") {
    throw new Error("Cannot issue a receipt for a payment that is not SUCCESS");
  }

  // Idempotency: a receipt may already exist for this payment.
  const existing = await prisma.receipt.findUnique({ where: { paymentId } });
  if (existing) return { receipt: existing, created: false };

  // Receipt numbers come from a count, so two concurrent issuers (for this
  // or a different payment) can pick the same number and one insert hits a
  // unique-constraint error (P2002). If the loser's payment now has a
  // receipt, another caller won the race - return theirs. Otherwise the
  // number itself collided, so regenerate and try again.
  for (let attempt = 0; attempt < 5; attempt++) {
    const receiptNumber = await generateReceiptNumber();
    try {
      const receipt = await prisma.$transaction(async (tx) => {
        const r = await tx.receipt.create({
          data: {
            receiptNumber,
            paymentId: payment.id,
            studentId: payment.studentId,
            departmentId: payment.departmentId,
          },
        });
        await tx.student.update({
          where: { id: payment.studentId },
          data: { paymentStatus: "SUCCESS" as any },
        });
        return r;
      });
      return { receipt, created: true };
    } catch (err: any) {
      if (err?.code !== "P2002") throw err;
      const winner = await prisma.receipt.findUnique({ where: { paymentId } });
      if (winner) return { receipt: winner, created: false };
    }
  }

  throw new Error("Could not allocate a unique receipt number after several attempts");
}

/**
 * Issues the receipt (if needed) and sends the notifications right here,
 * waiting for them. Kept for callers that want the old all-in-one
 * behaviour; the payment confirmation paths use issueReceipt() +
 * sendReceiptNotifications() in the background instead
 * (see src/lib/payments/confirm-payment.ts).
 * Notification failure (SMS/email) must never roll back the payment/receipt.
 */
export async function issueReceiptAndNotify(paymentId: string) {
  const payment = await prisma.payment.findUniqueOrThrow({
    where: { id: paymentId },
    include: {
      student: true,
      academicSession: true,
      department: { include: { smsConfig: true, emailConfig: true } },
    },
  });

  if (payment.status !== "SUCCESS") {
    throw new Error("Cannot issue a receipt for a payment that is not SUCCESS");
  }

  const { receipt, created } = await issueReceipt(paymentId);
  if (!created) return receipt;

  // Notifications happen outside the DB transaction and are best-effort -
  // one channel failing must never affect the other or the payment/receipt.
  await sendSmsReceipt(payment, receipt.receiptNumber).catch((e) =>
    captureError(e, { context: "sms-receipt", paymentId: payment.id })
  );
  await sendEmailReceipt(payment, receipt.receiptNumber, receipt.issuedAt).catch((e) =>
    captureError(e, { context: "email-receipt", paymentId: payment.id })
  );

  return receipt;
}

/**
 * Sends the SMS and email receipt for a payment that already succeeded and
 * already has a receipt. Never creates a receipt and never talks to the
 * payment provider. Re-reads the student fresh, so a phone/email an admin
 * has corrected since is what gets used. Each channel is independent: one
 * failing never blocks the other, and neither can change payment or
 * receipt state.
 *
 * This is what runs in the background after a payment is confirmed, and
 * what the admin "Resend Receipt" button calls.
 */
export async function sendReceiptNotifications(paymentId: string) {
  const payment = await prisma.payment.findUniqueOrThrow({
    where: { id: paymentId },
    include: {
      student: true,
      academicSession: true,
      department: { include: { smsConfig: true, emailConfig: true } },
      receipt: true,
    },
  });

  if (payment.status !== "SUCCESS" || !payment.receipt) {
    throw new Error("Cannot send a receipt for a payment that hasn't succeeded yet");
  }

  const results: { sms: "SENT" | "FAILED" | "SKIPPED"; email: "SENT" | "FAILED" | "SKIPPED" } = {
    sms: "SKIPPED",
    email: "SKIPPED",
  };

  try {
    results.sms = (await sendSmsReceipt(payment, payment.receipt.receiptNumber)) ?? "SKIPPED";
  } catch (e) {
    results.sms = "FAILED";
    captureError(e, { context: "sms-receipt", paymentId: payment.id });
  }

  try {
    results.email = (await sendEmailReceipt(payment, payment.receipt.receiptNumber, payment.receipt.issuedAt)) ?? "SKIPPED";
  } catch (e) {
    results.email = "FAILED";
    captureError(e, { context: "email-receipt", paymentId: payment.id });
  }

  return results;
}

/**
 * Manual re-send from the admin UI (the original send only ever fires once,
 * against whatever contact details were on file at that moment - so after
 * fixing a typo'd phone/email an admin needs a way to send it again).
 */
export async function resendReceipt(paymentId: string) {
  return sendReceiptNotifications(paymentId);
}

async function sendSmsReceipt(
  payment: Awaited<ReturnType<typeof prisma.payment.findUniqueOrThrow>> & {
    student: { fullName: string; referenceNumber: string; phone: string; level: string };
    department: {
      name: string;
      smsConfig: { senderId: string; messageTemplate: string; enabled: boolean; apiKey: string | null; username: string | null } | null;
    };
  },
  receiptNumber: string
) {
  const smsConfig = payment.department.smsConfig;
  if (!smsConfig || !smsConfig.enabled) return "SKIPPED" as const;

  // Student.level is stored as "L100".."L400" (see prisma schema) - drop
  // the leading "L" so the SMS reads "Level : 300" as requested, not "L300".
  const levelDisplay = payment.student.level.replace(/^L/, "");

  // payment.amount is a Prisma Decimal - format as plain "150" / "150.50",
  // no trailing ".00" clutter, no currency symbol baked in (template controls that).
  const amountNumber = Number(payment.amount);
  const amountDisplay = Number.isInteger(amountNumber) ? amountNumber.toString() : amountNumber.toFixed(2);

  const message = smsConfig.messageTemplate
    .replace("{department}", payment.department.name)
    .replace("{name}", payment.student.fullName)
    .replace("{reference}", payment.student.referenceNumber)
    .replace("{level}", levelDisplay)
    .replace("{amount}", amountDisplay)
    .replace("{receipt}", receiptNumber);

  const decryptedSmsConfig = decryptSmsApiKey(smsConfig);
  const smsProvider = getSmsProvider();
  const result = await smsProvider.send(
    {
      to: payment.student.phone,
      message,
      senderId: decryptedSmsConfig.senderId,
    },
    {
      apiKey: decryptedSmsConfig.apiKey,
      username: decryptedSmsConfig.username,
    }
  );

  await prisma.notificationLog.create({
    data: {
      departmentId: payment.departmentId,
      channel: "SMS",
      recipient: payment.student.phone,
      status: result.success ? "SENT" : "FAILED",
      errorMessage: result.error,
      relatedPaymentId: payment.id,
    },
  });

  // Explicitly: SMS failure must NEVER change payment.status or receipt state.
  if (result.success) return "SENT" as const;
  return "FAILED" as const;
}

async function sendEmailReceipt(
  payment: Awaited<ReturnType<typeof prisma.payment.findUniqueOrThrow>> & {
    student: { fullName: string; referenceNumber: string; email: string | null; level: string };
    academicSession: { name: string };
    department: {
      name: string;
      logoUrl: string | null;
      financialSecretaryName: string | null;
      financialSecretarySignatureUrl: string | null;
      presidentName: string | null;
      presidentSignatureUrl: string | null;
      emailConfig: { fromAddress: string | null; emailTemplate: string; enabled: boolean } | null;
    };
  },
  receiptNumber: string,
  issuedAt: Date
) {
  const emailConfig = payment.department.emailConfig;
  // Two independent conditions gate this, both required: the department
  // must have turned email receipts on, AND this particular student must
  // have an email on file (it's an optional field collected at checkout).
  if (!emailConfig || !emailConfig.enabled || !payment.student.email) return "SKIPPED" as const;

  const amountNumber = Number(payment.amount);
  const amountDisplay = Number.isInteger(amountNumber) ? amountNumber.toString() : amountNumber.toFixed(2);

  const body = emailConfig.emailTemplate
    .replace("{name}", payment.student.fullName)
    .replace("{department}", payment.department.name)
    .replace("{amount}", amountDisplay)
    .replace("{reference}", payment.student.referenceNumber)
    .replace("{receipt}", receiptNumber);

  // Attach the same PDF as the "Download Receipt" link on the
  // payment-status page (src/app/api/receipts/download/route.ts) - built
  // fresh here rather than reused, since it's cheap to generate and this
  // keeps the two code paths from drifting apart.
  let attachments: { filename: string; content: Buffer; contentType: string }[] | undefined;
  try {
    const baseUrl = process.env.NEXT_PUBLIC_APP_URL;
    const pdfBytes = await generateReceiptPdf({
      receiptNumber,
      issuedAt,
      department: payment.department,
      student: payment.student,
      payment: { amount: amountNumber, currency: payment.currency, paymentType: payment.paymentType, provider: payment.provider, paidAt: payment.paidAt },
      academicSessionName: payment.academicSession.name,
      verifyUrl: baseUrl ? `${baseUrl}/verify/${receiptNumber}` : null,
    });
    attachments = [{ filename: `${receiptNumber}.pdf`, content: Buffer.from(pdfBytes), contentType: "application/pdf" }];
  } catch (e) {
    // A PDF build failure must never block the email itself - the student
    // still gets their receipt text, just without the attachment this once.
    captureError(e, { context: "receipt-pdf-for-email", paymentId: payment.id });
  }

  const emailProvider = getEmailProvider();
  const result = await emailProvider.send({
    to: payment.student.email,
    subject: `${payment.department.name} dues receipt - ${receiptNumber}`,
    body,
    from: emailConfig.fromAddress ?? undefined,
    attachments,
  });

  await prisma.notificationLog.create({
    data: {
      departmentId: payment.departmentId,
      channel: "EMAIL",
      recipient: payment.student.email,
      status: result.success ? "SENT" : "FAILED",
      errorMessage: result.error,
      relatedPaymentId: payment.id,
    },
  });

  // Same rule as SMS: email failure must NEVER change payment/receipt state.
  if (result.success) return "SENT" as const;
  return "FAILED" as const;
}

// ---------------------------------------------------------------------------
// "Dues Cleared" (exempt) students
// ---------------------------------------------------------------------------

/**
 * Issues the clearance receipt for a student a super admin has just marked
 * "Dues Cleared". Database work only - the email is sendClearanceEmail().
 *
 * Each student has at most one clearance receipt (unique on studentId +
 * kind). If the clearance was removed earlier (receipt voided) and is now
 * granted again, the SAME receipt - same number - is revived rather than a
 * second one created, so a receipt number is never reused for a different
 * meaning and never orphaned.
 *
 * Safe to call twice: exactly one caller gets `created: true`.
 */
export async function issueClearanceReceipt(studentId: string) {
  const student = await prisma.student.findUniqueOrThrow({ where: { id: studentId } });
  if (!student.isExempt) {
    throw new Error("Cannot issue a clearance receipt for a student who is not marked Dues Cleared");
  }

  const existing = await prisma.receipt.findFirst({ where: { studentId, kind: "CLEARANCE" } });
  if (existing) {
    if (!existing.voidedAt) return { receipt: existing, created: false };
    const revived = await prisma.receipt.update({
      where: { id: existing.id },
      data: { voidedAt: null, issuedAt: new Date() },
    });
    return { receipt: revived, created: true };
  }

  for (let attempt = 0; attempt < 5; attempt++) {
    const receiptNumber = await generateReceiptNumber("CLR");
    try {
      const receipt = await prisma.receipt.create({
        data: {
          receiptNumber,
          kind: "CLEARANCE",
          studentId: student.id,
          departmentId: student.departmentId,
        },
      });
      return { receipt, created: true };
    } catch (err: any) {
      if (err?.code !== "P2002") throw err;
      // Either another caller just issued this student's clearance receipt,
      // or the number itself collided - same handling as issueReceipt().
      const winner = await prisma.receipt.findFirst({ where: { studentId, kind: "CLEARANCE" } });
      if (winner) return { receipt: winner, created: false };
    }
  }

  throw new Error("Could not allocate a unique clearance receipt number after several attempts");
}

export type ClearanceEmailResult = {
  status: "SENT" | "FAILED" | "SKIPPED";
  // Human-readable explanation for anything other than SENT, shown to the
  // super admin so they know why nothing arrived (and can still download
  // the PDF from the student row).
  reason?: string;
};

/**
 * Builds the clearance receipt PDF for a student. Returns null when the
 * student is not currently cleared or has no active (non-voided) clearance
 * receipt - callers treat that as "nothing to give out".
 */
export async function buildClearanceReceiptPdf(studentId: string) {
  const student = await prisma.student.findUnique({
    where: { id: studentId },
    include: {
      academicSession: true,
      department: true,
      receipts: { where: { kind: "CLEARANCE" } },
    },
  });
  const receipt = student?.receipts[0];
  if (!student || !student.isExempt || !receipt || receipt.voidedAt) return null;

  const baseUrl = process.env.NEXT_PUBLIC_APP_URL;
  const pdfBytes = await generateReceiptPdf({
    receiptNumber: receipt.receiptNumber,
    issuedAt: receipt.issuedAt,
    kind: "CLEARANCE",
    department: student.department,
    student,
    academicSessionName: student.academicSession.name,
    verifyUrl: baseUrl ? `${baseUrl}/verify/${receipt.receiptNumber}` : null,
  });

  return { pdfBytes, receiptNumber: receipt.receiptNumber, student };
}

/**
 * Emails a student their clearance receipt. Same rule as any other receipt:
 * only sent if the student has an email on file AND the department's email
 * setting is on. The wording is its own (the department's "payment of
 * {amount}" template makes no sense here) and the PDF is attached.
 *
 * No SMS is ever sent for clearances. Never throws for delivery problems -
 * returns a SKIPPED/FAILED result with a reason instead, and a failed send
 * is recorded in NotificationLog like other notification failures.
 */
export async function sendClearanceEmail(studentId: string): Promise<ClearanceEmailResult> {
  const student = await prisma.student.findUnique({
    where: { id: studentId },
    include: {
      academicSession: true,
      department: { include: { emailConfig: true } },
      receipts: { where: { kind: "CLEARANCE" } },
    },
  });
  const receipt = student?.receipts[0];
  if (!student || !student.isExempt || !receipt || receipt.voidedAt) {
    return { status: "SKIPPED", reason: "This student has no active clearance receipt" };
  }

  const emailConfig = student.department.emailConfig;
  if (!emailConfig || !emailConfig.enabled) {
    return { status: "SKIPPED", reason: "Email receipts are turned off for this department" };
  }
  if (!student.email) {
    return { status: "SKIPPED", reason: "This student has no email address on file" };
  }

  let attachments: { filename: string; content: Buffer; contentType: string }[] | undefined;
  try {
    const built = await buildClearanceReceiptPdf(studentId);
    if (built) {
      attachments = [
        { filename: `${receipt.receiptNumber}.pdf`, content: Buffer.from(built.pdfBytes), contentType: "application/pdf" },
      ];
    }
  } catch (e) {
    // A PDF build failure must never block the email itself.
    captureError(e, { context: "clearance-pdf-for-email", studentId });
  }

  const body =
    `Dear ${student.fullName}, your dues for ${student.department.name} (${student.academicSession.name}) ` +
    `have been cleared. No payment is required from you. ` +
    `Reference: ${student.referenceNumber}. Clearance receipt: ${receipt.receiptNumber}.` +
    (attachments ? " Your clearance receipt is attached." : "");

  const result = await getEmailProvider().send({
    to: student.email,
    subject: `${student.department.name} dues clearance - ${receipt.receiptNumber}`,
    body,
    from: emailConfig.fromAddress ?? undefined,
    attachments,
  });

  await prisma.notificationLog.create({
    data: {
      departmentId: student.departmentId,
      channel: "EMAIL",
      recipient: student.email,
      status: result.success ? "SENT" : "FAILED",
      errorMessage: result.error,
    },
  });

  if (result.success) return { status: "SENT" };
  return { status: "FAILED", reason: result.error ?? "The email provider could not send the message" };
}
