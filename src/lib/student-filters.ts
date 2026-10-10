import { scopedDepartmentWhere, type SessionUser } from "@/lib/authorization";

export type StudentFilterParams = {
  departmentId?: string | null;
  level?: string | null;
  paymentStatus?: string | null;
  registrationSource?: string | null;
  search?: string | null;
  exempt?: string | null;
};

export function readStudentFilterParams(searchParams: URLSearchParams): StudentFilterParams {
  return {
    departmentId: searchParams.get("departmentId"),
    level: searchParams.get("level"),
    paymentStatus: searchParams.get("paymentStatus"),
    registrationSource: searchParams.get("registrationSource"),
    search: searchParams.get("search"),
    exempt: searchParams.get("exempt"),
  };
}

/**
 * Single source of truth for the Students page filters, used by both the
 * on-screen list (GET /api/students) and the CSV export, so the two can
 * never disagree about what a filter means.
 *
 * `excludeClearedFromUnpaid` is for the export: a "Dues Cleared" student has
 * paymentStatus PENDING but owes nothing, so they don't belong on an unpaid
 * list. An explicit exempt filter still wins - asking for "Exempt only" plus
 * "Unpaid" gets exactly that, not an empty file.
 */
export function buildStudentWhere(
  user: SessionUser,
  p: StudentFilterParams,
  opts: { excludeClearedFromUnpaid?: boolean } = {}
) {
  const exemptFilter =
    p.exempt === "true"
      ? { isExempt: true }
      : p.exempt === "false"
        ? { isExempt: false }
        : opts.excludeClearedFromUnpaid && p.paymentStatus === "PENDING"
          ? { isExempt: false }
          : {};

  return {
    // scopedDepartmentWhere ignores departmentId entirely for DEPARTMENT_ADMIN,
    // so a department admin can never read another department's students by
    // manipulating the query string.
    ...scopedDepartmentWhere(user, p.departmentId),
    ...(p.level ? { level: p.level } : {}),
    ...(p.paymentStatus ? { paymentStatus: p.paymentStatus } : {}),
    ...(p.registrationSource ? { registrationSource: p.registrationSource } : {}),
    ...exemptFilter,
    ...(p.search
      ? {
          OR: [
            { fullName: { contains: p.search, mode: "insensitive" } },
            { referenceNumber: { contains: p.search, mode: "insensitive" } },
            { studentIndexNo: { contains: p.search, mode: "insensitive" } },
          ],
        }
      : {}),
  };
}
