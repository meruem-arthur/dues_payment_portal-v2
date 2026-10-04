import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { captureError } from "@/lib/monitoring/capture-error";
import { requireSuperAdmin, UnauthorizedError, ForbiddenError } from "@/lib/authorization";
import { supportSettingsSchema } from "@/lib/validations/support";
import { SUPPORT_SETTINGS_ID } from "@/lib/support-request";
import { logAudit } from "@/lib/audit";

// System-wide Contact Support email + phone. Super admin only.

export async function GET() {
  try {
    await requireSuperAdmin();
    const settings = await prisma.supportSettings.findUnique({ where: { id: SUPPORT_SETTINGS_ID } });
    return NextResponse.json({ email: settings?.email ?? "", phone: settings?.phone ?? "" });
  } catch (err) {
    return handleError(err);
  }
}

export async function PATCH(req: NextRequest) {
  try {
    const user = await requireSuperAdmin();
    const parsed = supportSettingsSchema.parse(await req.json());

    const data = { email: parsed.email || null, phone: parsed.phone || null };
    const settings = await prisma.supportSettings.upsert({
      where: { id: SUPPORT_SETTINGS_ID },
      create: { id: SUPPORT_SETTINGS_ID, ...data },
      update: data,
    });

    await logAudit({
      userId: user.id,
      action: "SUPPORT_SETTINGS_UPDATED",
      entity: "SupportSettings",
      entityId: settings.id,
      metadata: { emailSet: Boolean(settings.email), phoneSet: Boolean(settings.phone) },
    });

    return NextResponse.json({ email: settings.email ?? "", phone: settings.phone ?? "" });
  } catch (err) {
    return handleError(err);
  }
}

function handleError(err: unknown) {
  if (err instanceof UnauthorizedError) return NextResponse.json({ error: err.message }, { status: 401 });
  if (err instanceof ForbiddenError) return NextResponse.json({ error: err.message }, { status: 403 });
  if (err && typeof err === "object" && "issues" in err) {
    const first = (err as any).issues?.[0]?.message;
    return NextResponse.json({ error: first ?? "Invalid input" }, { status: 400 });
  }
  captureError(err);
  return NextResponse.json({ error: "Something went wrong" }, { status: 500 });
}
