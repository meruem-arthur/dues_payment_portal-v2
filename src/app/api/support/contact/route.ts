import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { captureError } from "@/lib/monitoring/capture-error";
import { checkRateLimit, getClientIp } from "@/lib/rate-limit";
import { supportRequestSchema } from "@/lib/validations/support";
import { sendSupportRequest } from "@/lib/support-request";

// Public endpoint (no login) - students use it when payment isn't working.
// Every accepted request can cost an SMS and an email, so it's rate-limited
// per IP. Support messages are far rarer than payment attempts, hence a
// much lower ceiling than /api/payments/initiate.
const RATE_LIMIT_MAX_REQUESTS = 10;
const RATE_LIMIT_WINDOW_MS = 10 * 60 * 1000;

export async function POST(req: NextRequest) {
  try {
    const ip = getClientIp(req);
    const rateLimit = checkRateLimit(`support:contact:${ip}`, RATE_LIMIT_MAX_REQUESTS, RATE_LIMIT_WINDOW_MS);
    if (!rateLimit.allowed) {
      return NextResponse.json(
        { error: "Too many messages sent. Please wait a few minutes and try again." },
        { status: 429, headers: { "Retry-After": String(rateLimit.retryAfterSeconds) } }
      );
    }

    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return NextResponse.json({ error: "Invalid request" }, { status: 400 });
    }
    const parsed = supportRequestSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: "Enter your reference number and describe the issue (at least a few words)." },
        { status: 400 }
      );
    }
    const input = parsed.data;

    const department = await prisma.department.findUnique({
      where: { slug: input.departmentSlug },
      include: { smsConfig: true },
    });
    if (!department || department.status === "ARCHIVED") {
      return NextResponse.json({ error: "Department not found" }, { status: 404 });
    }

    // Best-effort lookup so the admin sees who this is. A miss is fine -
    // e.g. a fresher whose very first payment attempt failed before their
    // record was created - and is reported as such in the message.
    const student = await prisma.student.findFirst({
      where: {
        departmentId: department.id,
        academicSessionId: department.academicSessionId,
        referenceNumber: input.referenceNumber,
      },
      select: { fullName: true, level: true, phone: true },
    });

    const result = await sendSupportRequest({
      department,
      referenceNumber: input.referenceNumber,
      message: input.message,
      student,
    });

    if (!result.ok) {
      if (result.reason === "NOT_CONFIGURED") {
        // Support contact not set up by the super admin yet - nothing was sent.
        return NextResponse.json(
          { error: "Support messaging isn't available right now. Please contact your department directly." },
          { status: 503 }
        );
      }
      return NextResponse.json(
        { error: "We couldn't send your message right now. Please try again in a few minutes." },
        { status: 502 }
      );
    }

    return NextResponse.json({ ok: true });
  } catch (err) {
    captureError(err);
    return NextResponse.json({ error: "Something went wrong. Please try again." }, { status: 500 });
  }
}
