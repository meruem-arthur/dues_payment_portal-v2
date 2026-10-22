import { NextRequest, NextResponse } from "next/server";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { captureError } from "@/lib/monitoring/capture-error";
import { authorizeFinanceApi } from "@/lib/finance/api-auth";
import { getFinanceConfig } from "@/lib/finance/config";
import { decodeCursor, encodeCursor, financePaymentSelect, toFinancePayload } from "@/lib/finance/payload";

// GET /api/finance/payments?cursor=...&limit=...
//
// Read-only feed for the finance portal: payments of the finance department
// that carry money (SUCCESS, or REFUNDED if one was refunded later), ordered
// by last-change time. The finance portal remembers the returned cursor and
// asks again for "everything changed since", which is how corrections
// (e.g. SUCCESS -> REFUNDED) reach it. Auth: Bearer FINANCE_API_KEY.

export const dynamic = "force-dynamic";

const DEFAULT_LIMIT = 200;
const MAX_LIMIT = 500;

export async function GET(req: NextRequest) {
  const denied = authorizeFinanceApi(req);
  if (denied) return denied;

  try {
    const { departmentCode } = getFinanceConfig();
    const params = req.nextUrl.searchParams;

    const rawLimit = Number(params.get("limit") ?? DEFAULT_LIMIT);
    const limit = Number.isFinite(rawLimit) ? Math.min(Math.max(Math.trunc(rawLimit), 1), MAX_LIMIT) : DEFAULT_LIMIT;

    const cursorParam = params.get("cursor");
    const cursor = cursorParam ? decodeCursor(cursorParam) : null;
    if (cursorParam && !cursor) {
      return NextResponse.json({ error: "Invalid cursor" }, { status: 400 });
    }

    const where: Prisma.PaymentWhereInput = {
      department: { code: { equals: departmentCode as string, mode: "insensitive" } },
      status: { in: ["SUCCESS", "REFUNDED"] },
      ...(cursor
        ? {
            OR: [
              { updatedAt: { gt: cursor.updatedAt } },
              { updatedAt: cursor.updatedAt, id: { gt: cursor.id } },
            ],
          }
        : {}),
    };

    const rows = await prisma.payment.findMany({
      where,
      select: financePaymentSelect,
      orderBy: [{ updatedAt: "asc" }, { id: "asc" }],
      take: limit + 1,
    });

    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    const last = page[page.length - 1];

    return NextResponse.json({
      payments: page.map(toFinancePayload),
      // With no new rows the caller's own cursor is echoed back unchanged.
      nextCursor: last ? encodeCursor(last.updatedAt, last.id) : cursorParam,
      hasMore,
    });
  } catch (err) {
    captureError(err, { context: "finance-payments-feed" });
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
