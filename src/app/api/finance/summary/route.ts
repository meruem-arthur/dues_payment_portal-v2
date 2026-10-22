import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { captureError } from "@/lib/monitoring/capture-error";
import { authorizeFinanceApi } from "@/lib/finance/api-auth";
import { getFinanceConfig } from "@/lib/finance/config";

// GET /api/finance/summary
//
// Totals the finance portal compares against its own copy to detect drift
// ("in sync" / "differs by GH₵X"). Auth: Bearer FINANCE_API_KEY.

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const denied = authorizeFinanceApi(req);
  if (denied) return denied;

  try {
    const { departmentCode } = getFinanceConfig();
    const groups = await prisma.payment.groupBy({
      by: ["status"],
      where: {
        department: { code: { equals: departmentCode as string, mode: "insensitive" } },
        status: { in: ["SUCCESS", "REFUNDED"] },
      },
      _sum: { amount: true },
      _count: { _all: true },
    });

    const pick = (status: "SUCCESS" | "REFUNDED") => {
      const g = groups.find((x) => x.status === status);
      return { count: g?._count._all ?? 0, total: (g?._sum.amount ?? 0).toString() };
    };

    return NextResponse.json({
      departmentCode,
      success: pick("SUCCESS"),
      refunded: pick("REFUNDED"),
      generatedAt: new Date().toISOString(),
    });
  } catch (err) {
    captureError(err, { context: "finance-summary" });
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
