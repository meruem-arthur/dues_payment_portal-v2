import { NextRequest, NextResponse } from "next/server";
import { getFinanceConfig, isFinanceApiEnabled } from "./config";
import { timingSafeEqualStrings } from "./signing";

/**
 * Bearer-key gate for /api/finance/payments and /api/finance/summary.
 * Returns a ready-made error response, or null when the caller is allowed.
 * Closed by default: with FINANCE_API_KEY unset every request is refused.
 */
export function authorizeFinanceApi(req: NextRequest): NextResponse | null {
  const config = getFinanceConfig();
  if (!isFinanceApiEnabled(config)) {
    return NextResponse.json({ error: "Finance API is not configured" }, { status: 503 });
  }
  const header = req.headers.get("authorization") ?? "";
  const match = /^Bearer\s+(.+)$/i.exec(header);
  if (!match || !timingSafeEqualStrings(match[1].trim(), config.apiKey as string)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  return null;
}
