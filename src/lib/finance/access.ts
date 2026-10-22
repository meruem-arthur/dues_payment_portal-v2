import { prisma } from "@/lib/db";
import { departmentCodesMatch, getFinanceConfig } from "./config";

export type FinanceAccess =
  | { allowed: true; user: { id: string; name: string; email: string; role: "SUPER_ADMIN" | "DEPARTMENT_ADMIN" } }
  | { allowed: false; reason: "not-configured" | "inactive" | "other-department" };

/**
 * Who may open the finance portal from here.
 *  - SUPER_ADMIN: always (platform-wide role).
 *  - DEPARTMENT_ADMIN: only when their department's code is the finance portal's department.
 * Reads the user from the database rather than trusting the session JWT, so a
 * deactivated or re-assigned admin loses access immediately.
 *
 * This only gets someone THROUGH THE DOOR. What they can do inside (and
 * whether they get in at all as financial secretary) is decided by the
 * super admin inside the finance portal.
 */
export async function resolveFinanceAccess(userId: string): Promise<FinanceAccess> {
  const { departmentCode } = getFinanceConfig();
  if (!departmentCode) return { allowed: false, reason: "not-configured" };

  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      id: true,
      name: true,
      email: true,
      role: true,
      status: true,
      department: { select: { code: true } },
    },
  });
  if (!user || user.status !== "ACTIVE") return { allowed: false, reason: "inactive" };

  const summary = { id: user.id, name: user.name, email: user.email, role: user.role };
  if (user.role === "SUPER_ADMIN") return { allowed: true, user: summary };
  if (user.role === "DEPARTMENT_ADMIN" && departmentCodesMatch(user.department?.code, departmentCode)) {
    return { allowed: true, user: summary };
  }
  return { allowed: false, reason: "other-department" };
}
