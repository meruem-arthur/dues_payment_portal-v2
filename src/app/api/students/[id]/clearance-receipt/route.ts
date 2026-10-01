import { NextRequest, NextResponse } from "next/server";
import { captureError } from "@/lib/monitoring/capture-error";
import { prisma } from "@/lib/db";
import { requireSuperAdmin, UnauthorizedError, ForbiddenError } from "@/lib/authorization";
import { buildClearanceReceiptPdf } from "@/lib/receipts";

// GET /api/students/[id]/clearance-receipt - super admin downloads the
// clearance PDF straight from the student row (works even when the email
// couldn't be sent).
export async function GET(_req: NextRequest, { params }: { params: { id: string } }) {
  try {
    await requireSuperAdmin();
    await prisma.student.findUniqueOrThrow({ where: { id: params.id }, select: { id: true } });

    const built = await buildClearanceReceiptPdf(params.id);
    if (!built) {
      return NextResponse.json({ error: "This student has no active clearance receipt" }, { status: 404 });
    }
    return new NextResponse(Buffer.from(built.pdfBytes), {
      status: 200,
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": `attachment; filename="${built.receiptNumber}.pdf"`,
        "Cache-Control": "no-store",
      },
    });
  } catch (err) {
    if (err instanceof UnauthorizedError) return NextResponse.json({ error: err.message }, { status: 401 });
    if (err instanceof ForbiddenError) return NextResponse.json({ error: err.message }, { status: 403 });
    captureError(err);
    return NextResponse.json({ error: "Could not generate receipt" }, { status: 500 });
  }
}
