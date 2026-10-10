import { NextRequest, NextResponse } from "next/server";
import { captureError } from "@/lib/monitoring/capture-error";
import { prisma } from "@/lib/db";
import { requireSuperAdmin, UnauthorizedError, ForbiddenError } from "@/lib/authorization";
import { buildStudentWhere, readStudentFilterParams } from "@/lib/student-filters";
import { studentsToCsv, exportFilename } from "@/lib/student-export";
import { logAudit } from "@/lib/audit";

// Super admin only. Exports exactly what the Students page filters select,
// for ONE department (the one selected in the switcher) - unlike the list
// endpoint this has no 500-row cap, so a full class list is never cut short.
export async function GET(req: NextRequest) {
  try {
    const user = await requireSuperAdmin();
    const { searchParams } = new URL(req.url);
    const filters = readStudentFilterParams(searchParams);

    // Required, so an export can never silently span every department.
    if (!filters.departmentId) {
      return NextResponse.json({ error: "departmentId is required" }, { status: 400 });
    }
    const department = await prisma.department.findUnique({
      where: { id: filters.departmentId },
      select: { id: true, name: true },
    });
    if (!department) return NextResponse.json({ error: "Department not found" }, { status: 404 });

    const students = await prisma.student.findMany({
      where: buildStudentWhere(user, filters, { excludeClearedFromUnpaid: true }),
      orderBy: [{ level: "asc" }, { fullName: "asc" }],
      select: {
        fullName: true,
        referenceNumber: true,
        studentIndexNo: true,
        level: true,
        phone: true,
        email: true,
        paymentStatus: true,
        isExempt: true,
        registrationSource: true,
      },
    });

    // This file carries students' phone numbers and emails, so every export
    // is recorded: who, which department, which filters, how many rows.
    await logAudit({
      userId: user.id,
      departmentId: department.id,
      action: "STUDENTS_EXPORTED",
      entity: "Student",
      metadata: {
        rowCount: students.length,
        level: filters.level ?? null,
        paymentStatus: filters.paymentStatus ?? null,
        exempt: filters.exempt ?? null,
        registrationSource: filters.registrationSource ?? null,
        search: filters.search ?? null,
      },
    });

    const filename = exportFilename({
      departmentName: department.name,
      level: filters.level,
      paymentStatus: filters.paymentStatus,
      exempt: filters.exempt,
      search: filters.search,
    });

    return new NextResponse(studentsToCsv(students as any), {
      status: 200,
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="${filename}"`,
        "Cache-Control": "no-store",
      },
    });
  } catch (err) {
    if (err instanceof UnauthorizedError) return NextResponse.json({ error: err.message }, { status: 401 });
    if (err instanceof ForbiddenError) return NextResponse.json({ error: err.message }, { status: 403 });
    captureError(err);
    return NextResponse.json({ error: "Could not export students" }, { status: 500 });
  }
}
