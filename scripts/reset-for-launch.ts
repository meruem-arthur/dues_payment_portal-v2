// One-time, pre-launch reset: wipes every department, academic session,
// student, payment, receipt, department-admin account, audit log, webhook
// event and notification log - so you can go live with a completely clean
// slate, no leftover test/archived departments.
//
// This is deliberately a SEPARATE script from the app's own API, not a
// hidden admin button - the app itself intentionally refuses to hard-delete
// departments, admins or audit logs (see the comments on the Department and
// AuditLog models in prisma/schema.prisma) because once you're live, a
// payment/audit record must never be able to disappear. This script exists
// for the one moment where that protection is actively in your way: before
// you've taken a single real payment.
//
// What it KEEPS:
//   - Every SUPER_ADMIN user (so you don't lock yourself out). Nothing else.
// What it DELETES (in FK-safe order):
//   WebhookEvent, Receipt, NotificationLog, AuditLog, Payment, Student,
//   PaymentProviderConfiguration, SmsConfiguration, EmailConfiguration,
//   DEPARTMENT_ADMIN users, Department, AcademicSession,
//   PasswordResetToken (cascades automatically with its User).
//
// SAFETY:
//   - Refuses to run at all unless you pass --yes.
//   - Always does a dry run first (prints counts) - add --yes a second time
//     (i.e. run it twice) is NOT required; --yes alone runs it for real, but
//     read the printed counts before typing y at the prompt.
//   - Prints which database it's about to touch (host + db name only, never
//     the password) so you can double check you're not pointed at something
//     you didn't mean to wipe.
//
// STRONGLY recommended: take a database backup/snapshot before running this
// (e.g. `pg_dump $DATABASE_URL > backup-before-reset.sql`), even though this
// is meant for a database with nothing real in it yet - a wrong DATABASE_URL
// is a one-line mistake away.
//
// Usage:
//   npx tsx scripts/reset-for-launch.ts          # dry run - just prints counts
//   npx tsx scripts/reset-for-launch.ts --yes     # actually deletes, after
//                                                  # one interactive confirmation

import * as readline from "node:readline/promises";
import { prisma } from "../src/lib/db";

const DO_IT = process.argv.includes("--yes");

function describeTargetDb(): string {
  try {
    const url = new URL(process.env.DATABASE_URL ?? "");
    return `${url.hostname}${url.pathname}`;
  } catch {
    return "(could not parse DATABASE_URL)";
  }
}

async function main() {
  console.log(`Target database: ${describeTargetDb()}`);

  const [
    webhookEvents,
    receipts,
    notificationLogs,
    auditLogs,
    payments,
    students,
    departmentAdmins,
    departments,
    sessions,
  ] = await Promise.all([
    prisma.webhookEvent.count(),
    prisma.receipt.count(),
    prisma.notificationLog.count(),
    prisma.auditLog.count(),
    prisma.payment.count(),
    prisma.student.count(),
    prisma.user.count({ where: { role: "DEPARTMENT_ADMIN" } }),
    prisma.department.count(),
    prisma.academicSession.count(),
  ]);
  const superAdmins = await prisma.user.count({ where: { role: "SUPER_ADMIN" } });

  console.log("\nThis will permanently delete:");
  console.log(`  ${webhookEvents} webhook event(s)`);
  console.log(`  ${receipts} receipt(s)`);
  console.log(`  ${notificationLogs} notification log(s)`);
  console.log(`  ${auditLogs} audit log(s)`);
  console.log(`  ${payments} payment(s)`);
  console.log(`  ${students} student(s)`);
  console.log(`  ${departmentAdmins} department admin account(s)`);
  console.log(`  ${departments} department(s)`);
  console.log(`  ${sessions} academic session(s)`);
  console.log(`\nThis will KEEP: ${superAdmins} super admin account(s) - you can still log in afterward.`);

  if (!DO_IT) {
    console.log("\nDry run only - nothing was deleted. Re-run with --yes to actually do this.");
    return;
  }

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = await rl.question('\nType "RESET" (all caps) to confirm permanent deletion: ');
  rl.close();
  if (answer.trim() !== "RESET") {
    console.log("Confirmation text did not match - aborted, nothing was deleted.");
    return;
  }

  console.log("\nDeleting...");
  // Order matters: children before the parents they reference.
  await prisma.webhookEvent.deleteMany();
  await prisma.receipt.deleteMany();
  await prisma.notificationLog.deleteMany();
  await prisma.auditLog.deleteMany();
  await prisma.payment.deleteMany();
  await prisma.student.deleteMany();
  await prisma.paymentProviderConfiguration.deleteMany();
  await prisma.smsConfiguration.deleteMany();
  await prisma.emailConfiguration.deleteMany();
  await prisma.user.deleteMany({ where: { role: "DEPARTMENT_ADMIN" } });
  await prisma.department.deleteMany();
  await prisma.academicSession.deleteMany();

  console.log("Done. Database is clean - only your super admin account(s) remain.");
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
