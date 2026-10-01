import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { captureError } from "@/lib/monitoring/capture-error";
import { prisma } from "@/lib/db";
import { requireSuperAdmin, UnauthorizedError, ForbiddenError } from "@/lib/authorization";
import { issueClearanceReceipt, sendClearanceEmail } from "@/lib/receipts";
import { logAudit } from "@/lib/audit";

const exemptSchema = z.object({
  reason: z.string().trim().min(3, "A reason is required").max(500),
});

// POST /api/students/[id]/exempt - mark a student "Dues Cleared".
// SUPER_ADMIN only (department admins and financial secretaries get 403).
// The word "exempt" and the reason stay in admin screens; the public only
// ever sees "Dues Cleared".
export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  try {
    const user = await requireSuperAdmin();
    const { reason } = exemptSchema.parse(await req.json());

    const student = await prisma.student.findUniqueOrThrow({ where: { id: params.id } });

    if (student.isExempt) {
      return NextResponse.json({ error: "This student is already marked Dues Cleared" }, { status: 409 });
    }
    if (student.level === "L100") {
      return NextResponse.json({ error: "Level 100 students cannot be marked Dues Cleared" }, { status: 400 });
    }
    const blockingPayment = await prisma.payment.findFirst({
      where: { studentId: student.id, status: { in: ["SUCCESS", "PENDING"] } },
      select: { status: true },
    });
    if (student.paymentStatus === "SUCCESS" || blockingPayment) {
      return NextResponse.json(
        {
          error:
            blockingPayment?.status === "PENDING"
              ? "This student has a payment in progress. Resolve or cancel it first."
              : "This student has already paid and cannot be marked Dues Cleared",
        },
        { status: 409 }
      );
    }

    await prisma.student.update({
      where: { id: student.id },
      data: { isExempt: true, exemptReason: reason, exemptedAt: new Date(), exemptedById: user.id },
    });

    let receipt;
    try {
      ({ receipt } = await issueClearanceReceipt(student.id));
    } catch (err) {
      // Don't leave a cleared student with no receipt behind.
      await prisma.student.update({
        where: { id: student.id },
        data: { isExempt: false, exemptReason: null, exemptedAt: null, exemptedById: null },
      });
      throw err;
    }

    // Best-effort: a delivery problem never undoes the clearance. The super
    // admin is told why and can still download the PDF from the row.
    const email = await sendClearanceEmail(student.id).catch((e) => {
      captureError(e, { context: "clearance-email", studentId: student.id });
      return { status: "FAILED" as const, reason: "Could not send the email" };
    });

    await logAudit({
      userId: user.id,
      departmentId: student.departmentId,
      action: "STUDENT_EXEMPTED",
      entity: "Student",
      entityId: student.id,
      metadata: { referenceNumber: student.referenceNumber, reason, receiptNumber: receipt.receiptNumber, email: email.status },
    });

    return NextResponse.json({ receiptNumber: receipt.receiptNumber, email });
  } catch (err) {
    return handleError(err);
  }
}

// DELETE /api/students/[id]/exempt - remove the clearance. The receipt is
// voided (kept, never deleted) so /verify stops accepting it.
export async function DELETE(_req: NextRequest, { params }: { params: { id: string } }) {
  try {
    const user = await requireSuperAdmin();
    const student = await prisma.student.findUniqueOrThrow({ where: { id: params.id } });

    if (!student.isExempt) {
      return NextResponse.json({ error: "This student is not marked Dues Cleared" }, { status: 409 });
    }

    await prisma.$transaction([
      prisma.student.update({
        where: { id: student.id },
        data: { isExempt: false, exemptReason: null, exemptedAt: null, exemptedById: null },
      }),
      prisma.receipt.updateMany({
        where: { studentId: student.id, kind: "CLEARANCE", voidedAt: null },
        data: { voidedAt: new Date() },
      }),
    ]);

    await logAudit({
      userId: user.id,
      departmentId: student.departmentId,
      action: "EXEMPTION_REMOVED",
      entity: "Student",
      entityId: student.id,
      metadata: { referenceNumber: student.referenceNumber, previousReason: student.exemptReason },
    });

    return NextResponse.json({ success: true });
  } catch (err) {
    return handleError(err);
  }
}

function handleError(err: unknown) {
  if (err instanceof UnauthorizedError) return NextResponse.json({ error: err.message }, { status: 401 });
  if (err instanceof ForbiddenError) return NextResponse.json({ error: err.message }, { status: 403 });
  if (err instanceof z.ZodError) {
    return NextResponse.json({ error: err.issues[0]?.message ?? "Invalid request" }, { status: 400 });
  }
  captureError(err);
  return NextResponse.json({ error: "Something went wrong" }, { status: 500 });
}
