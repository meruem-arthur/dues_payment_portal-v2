import { NextRequest, NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/authorization";
import { logAudit } from "@/lib/audit";
import { captureError } from "@/lib/monitoring/capture-error";
import { getFinanceConfig, isFinanceSsoEnabled } from "@/lib/finance/config";
import { resolveFinanceAccess } from "@/lib/finance/access";
import { createSsoToken } from "@/lib/finance/signing";

// GET /api/finance/sso
//
// Sign-in handoff to the finance portal. The admin is already logged in here;
// we mint a 60-second signed token naming them and send the browser to the
// finance portal with the token in the URL FRAGMENT (#token=...), which
// browsers never send to a server or put in a Referer header. The finance
// portal verifies the signature, accepts each token once, and decides for
// itself what role (if any) the person has there.

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  try {
    const config = getFinanceConfig();
    if (!isFinanceSsoEnabled(config)) {
      return NextResponse.json({ error: "Finance portal integration is not configured" }, { status: 503 });
    }

    const sessionUser = await getCurrentUser();
    if (!sessionUser) {
      const login = new URL("/login", req.url);
      login.searchParams.set("callbackUrl", "/api/finance/sso");
      return NextResponse.redirect(login);
    }

    const access = await resolveFinanceAccess(sessionUser.id);
    if (!access.allowed) {
      return NextResponse.json({ error: "Your account does not have access to the finance portal" }, { status: 403 });
    }

    const token = createSsoToken(
      {
        sub: access.user.id,
        name: access.user.name,
        email: access.user.email,
        role: access.user.role,
        departmentCode: config.departmentCode as string,
      },
      config.pushToken as string
    );

    await logAudit({
      userId: access.user.id,
      action: "FINANCE_PORTAL_SIGN_IN",
      entity: "FinancePortal",
    });

    const res = NextResponse.redirect(`${config.portalUrl}/auth/sso#token=${token}`);
    res.headers.set("Cache-Control", "no-store");
    return res;
  } catch (err) {
    captureError(err, { context: "finance-sso" });
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
