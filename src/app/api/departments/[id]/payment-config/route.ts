import { NextRequest, NextResponse } from "next/server";
import { captureError } from "@/lib/monitoring/capture-error";
import { prisma } from "@/lib/db";
import { requireSuperAdmin, UnauthorizedError, ForbiddenError } from "@/lib/authorization";
import { paymentProviderConfigUpdateSchema, paymentTypeSchema } from "@/lib/validations/department";
import { logAudit } from "@/lib/audit";
import { encryptSecret } from "@/lib/crypto/field-encryption";

// Payment credentials for an already-created department.
//
// This is intentionally a separate file from src/app/api/departments/route.ts
// (the department create/list endpoint) and from src/app/api/departments/[id]/
// itself - nothing there is touched by this feature. The create-department
// form only ever collects the provider + the generic "configValue" field;
// the real secretKey/publicKey/webhookSecret are added afterward here, which
// is also the only place they can be rotated once set.
//
// Credentials are kept per student type (FRESHER / CONTINUING) in
// PaymentTypeConfiguration so the two groups can pay into different provider
// accounts. GET/PATCH take a paymentType; a type with no row of its own shows
// (and starts from) the department's original single config, which is also
// what payments fall back to - see src/lib/payments/resolve-config.ts.
//
// Only SUPER_ADMIN may read or write this - department admins should never
// see or manage the raw provider secret key for their own department.

export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  try {
    await requireSuperAdmin();

    const department = await prisma.department.findUnique({
      where: { id: params.id },
      select: { id: true, name: true },
    });
    if (!department) {
      return NextResponse.json({ error: "Department not found" }, { status: 404 });
    }

    const typeParam = req.nextUrl.searchParams.get("type");
    const paymentType = typeParam ? paymentTypeSchema.parse(typeParam) : undefined;

    const legacy = await prisma.paymentProviderConfiguration.findUnique({
      where: { departmentId: params.id },
    });
    const typed = paymentType
      ? await prisma.paymentTypeConfiguration.findUnique({
          where: { departmentId_paymentType: { departmentId: params.id, paymentType } },
        })
      : null;

    // With a type: that type's own row, or the department's original config
    // when it has none yet (the same fallback payments use). Without a type:
    // the original config, as before.
    const config = typed ?? legacy;

    // Secrets are never sent to the client. The frontend only learns
    // whether a given secret has been set, not its value, so it can show
    // e.g. "Secret key is set - leave blank to keep it" placeholder text.
    return NextResponse.json({
      config: config ? serializeConfig(config) : null,
    });
  } catch (err) {
    return handleError(err);
  }
}

export async function PATCH(req: NextRequest, { params }: { params: { id: string } }) {
  try {
    const user = await requireSuperAdmin();
    const body = await req.json();
    const parsed = paymentProviderConfigUpdateSchema.parse(body);

    const department = await prisma.department.findUnique({
      where: { id: params.id },
      select: { id: true },
    });
    if (!department) {
      return NextResponse.json({ error: "Department not found" }, { status: 404 });
    }

    // Convention: an omitted or blank secret-bearing field means "leave
    // this credential as it is" - not "clear it". Otherwise re-saving the
    // form after only rotating the secret key would silently wipe the
    // public key (which the client never receives back, so it can only
    // ever resubmit it if the user retypes it). Non-secret fields
    // (provider/environment) update whenever they're explicitly provided.
    //
    // secretKey/webhookSecret are encrypted at rest (see field-encryption.ts).
    // Only a freshly-submitted plaintext value from the form gets encrypted
    // here - the `existing` fallback is already-encrypted (or, for rows
    // saved before encryption was added, legacy plaintext) and is written
    // straight back unchanged either way.
    const secretIfProvided = (v: string | undefined) => (v ? v : undefined);
    const encryptedSecretIfProvided = (v: string | undefined) => (v ? encryptSecret(v) : undefined);

    const legacy = await prisma.paymentProviderConfiguration.findUnique({
      where: { departmentId: params.id },
    });

    // Which credential set is being edited. With a paymentType it's that
    // type's own row; if the type has none yet, the edit starts from the
    // department's original config (so untouched fields keep their current
    // values and nothing is lost) and creates the type's row. Without a
    // paymentType it's the original single config, as before.
    const typedExisting = parsed.paymentType
      ? await prisma.paymentTypeConfiguration.findUnique({
          where: { departmentId_paymentType: { departmentId: params.id, paymentType: parsed.paymentType } },
        })
      : null;
    const existing = typedExisting ?? legacy;

    const data = {
      provider: parsed.provider ?? existing?.provider ?? "PAYSTACK",
      environment: parsed.environment ?? existing?.environment ?? "TEST",
      publicKey: secretIfProvided(parsed.publicKey) ?? existing?.publicKey ?? null,
      secretKey: encryptedSecretIfProvided(parsed.secretKey) ?? existing?.secretKey ?? null,
      webhookSecret: encryptedSecretIfProvided(parsed.webhookSecret) ?? existing?.webhookSecret ?? null,
      configValue: secretIfProvided(parsed.configValue) ?? existing?.configValue ?? null,
    };

    const paymentType = parsed.paymentType;
    const config = paymentType
      ? await prisma.paymentTypeConfiguration.upsert({
          where: { departmentId_paymentType: { departmentId: params.id, paymentType } },
          create: { departmentId: params.id, paymentType, ...data },
          update: data,
        })
      : await prisma.paymentProviderConfiguration.upsert({
          where: { departmentId: params.id },
          create: { departmentId: params.id, ...data },
          update: data,
        });

    // Never write secret values into the audit log - only which fields
    // changed and the non-secret provider/environment selection.
    await logAudit({
      userId: user.id,
      departmentId: params.id,
      action: "PAYMENT_CONFIG_UPDATED",
      entity: paymentType ? "PaymentTypeConfiguration" : "PaymentProviderConfiguration",
      entityId: config.id,
      metadata: {
        paymentType: paymentType ?? null,
        provider: config.provider,
        environment: config.environment,
        publicKeyChanged: Boolean(parsed.publicKey),
        secretKeyChanged: Boolean(parsed.secretKey),
        webhookSecretChanged: Boolean(parsed.webhookSecret),
        configValueChanged: Boolean(parsed.configValue),
      },
    });

    return NextResponse.json({ config: serializeConfig(config) });
  } catch (err) {
    return handleError(err);
  }
}

// The only shape ever sent to the browser: secrets are reported as
// set/not-set, never returned.
function serializeConfig(config: {
  provider: string;
  environment: string;
  publicKey: string | null;
  configValue: string | null;
  secretKey: string | null;
  webhookSecret: string | null;
  updatedAt: Date;
}) {
  return {
    provider: config.provider,
    environment: config.environment,
    publicKey: config.publicKey ?? "",
    configValue: config.configValue ?? "",
    hasSecretKey: Boolean(config.secretKey),
    hasWebhookSecret: Boolean(config.webhookSecret),
    updatedAt: config.updatedAt,
  };
}

function handleError(err: unknown) {
  if (err instanceof UnauthorizedError) return NextResponse.json({ error: err.message }, { status: 401 });
  if (err instanceof ForbiddenError) return NextResponse.json({ error: err.message }, { status: 403 });
  if (err && typeof err === "object" && "issues" in err) {
    // zod error
    return NextResponse.json({ error: "Invalid input", details: (err as any).issues }, { status: 400 });
  }
  captureError(err);
  return NextResponse.json({ error: "Something went wrong" }, { status: 500 });
}
