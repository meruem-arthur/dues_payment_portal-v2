import { NextRequest, NextResponse } from "next/server";
import { captureError } from "@/lib/monitoring/capture-error";
import { prisma } from "@/lib/db";
import { requireDepartmentAccess, UnauthorizedError, ForbiddenError } from "@/lib/authorization";
import { reconcilePayment } from "@/lib/payments/reconcile";

// POST /api/students/[id]/verify-payment
//
// "Check payment": asks the payment provider directly what happened to the
// student's pending payment, instead of waiting for a webhook that may never
// come. If the provider says it went through, the payment is confirmed and the
// receipt issued exactly as if the webhook had arrived. If it says it failed,
// the payment is marked FAILED. If it's genuinely still in progress, nothing
// changes.
//
// This is the non-destructive counterpart to cancel-pending-payment: check
// first, and only cancel once the provider confirms it didn't go through.
export async function POST(_req: NextRequest, { params }: { params: { id: string } }) {
  try {
    const student = await prisma.student.findUniqueOrThrow({ where: { id: params.id } });
    const user = await requireDepartmentAccess(student.departmentId);

    const pending = await prisma.payment.findFirst({
      where: { studentId: student.id, status: "PENDING" },
      orderBy: { createdAt: "desc" },
      select: { id: true },
    });

    if (!pending) {
      return NextResponse.json({ error: "This student has no pending payment to check" }, { status: 404 });
    }

    const result = await reconcilePayment(pending.id, { source: "admin", actorUserId: user.id });
    return NextResponse.json(result);
  } catch (err) {
    if (err instanceof UnauthorizedError) return NextResponse.json({ error: err.message }, { status: 401 });
    if (err instanceof ForbiddenError) return NextResponse.json({ error: err.message }, { status: 403 });
    captureError(err);
    return NextResponse.json({ error: "Could not check the payment" }, { status: 500 });
  }
}
