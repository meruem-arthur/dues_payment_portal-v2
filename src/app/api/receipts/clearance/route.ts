import { NextRequest, NextResponse } from "next/server";
import { checkRateLimit, getClientIp } from "@/lib/rate-limit";
import { verifyClearanceToken } from "@/lib/clearance-token";
import { buildClearanceReceiptPdf } from "@/lib/receipts";
import { captureError } from "@/lib/monitoring/capture-error";

// GET /api/receipts/clearance?token=<signed token>
//
// Public, but only reachable with the short-lived token /api/students/lookup
// hands to a "Dues Cleared" student after they enter a valid reference
// number. There is deliberately no URL keyed by receipt number: those are
// sequential, so a permanent public link could be enumerated. The token is
// signed with AUTH_SECRET and expires after about 15 minutes.
//
// Rate-limited per IP like the other public routes, since the same
// campus-WiFi / carrier-NAT burst applies here.
const RATE_LIMIT_MAX_REQUESTS = 100;
const RATE_LIMIT_WINDOW_MS = 10 * 60 * 1000;

export async function GET(req: NextRequest) {
  try {
    const ip = getClientIp(req);
    const rateLimit = checkRateLimit(`receipts:clearance:${ip}`, RATE_LIMIT_MAX_REQUESTS, RATE_LIMIT_WINDOW_MS);
    if (!rateLimit.allowed) {
      return NextResponse.json(
        { error: "Too many attempts. Please wait a few minutes and try again." },
        { status: 429, headers: { "Retry-After": String(rateLimit.retryAfterSeconds) } }
      );
    }

    const token = req.nextUrl.searchParams.get("token");
    if (!token) {
      return NextResponse.json({ error: "Missing token" }, { status: 400 });
    }

    const result = verifyClearanceToken(token);
    if (!result.valid) {
      // Expired gets its own message so the student knows to just look
      // themselves up again; anything else looks the same as a bad link.
      const error =
        result.reason === "expired"
          ? "This link has expired. Go back and enter your reference number again."
          : "Invalid receipt link";
      return NextResponse.json({ error }, { status: result.reason === "expired" ? 410 : 400 });
    }

    const built = await buildClearanceReceiptPdf(result.studentId);
    if (!built) {
      return NextResponse.json({ error: "No receipt found" }, { status: 404 });
    }

    return new NextResponse(Buffer.from(built.pdfBytes), {
      status: 200,
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": `attachment; filename="${built.receiptNumber}.pdf"`,
        // Unlike a payment receipt, a clearance can be removed - don't let
        // a browser or proxy keep serving it afterwards.
        "Cache-Control": "no-store",
      },
    });
  } catch (err) {
    captureError(err, { context: "clearance-receipt-download" });
    return NextResponse.json({ error: "Could not generate receipt" }, { status: 500 });
  }
}
