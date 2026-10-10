import Papa from "papaparse";

export type ExportStudent = {
  fullName: string;
  referenceNumber: string;
  studentIndexNo: string | null;
  level: string;
  phone: string;
  email: string | null;
  paymentStatus: string;
  isExempt: boolean;
  registrationSource: string;
};

/**
 * Spreadsheet formula injection guard. Student names, phones and emails can
 * come from the public self-registration form, so a value like
 * `=HYPERLINK(...)` could execute when an admin opens the file in Excel.
 * Cells starting with = @ tab or CR are prefixed with a quote; + and - are
 * only left alone when they look like a phone number (e.g. +233 55 123 4567).
 */
export function safeCell(value: string | null | undefined): string {
  const v = value ?? "";
  if (/^[=@\t\r]/.test(v)) return `'${v}`;
  if (/^[+-]/.test(v) && !/^[+-][\d\s().-]+$/.test(v)) return `'${v}`;
  return v;
}

function statusLabel(s: ExportStudent) {
  // A cleared student's stored status is PENDING; calling them "Unpaid"
  // in a file would be wrong, so say what they actually are.
  if (s.isExempt) return "Dues Cleared";
  return s.paymentStatus === "SUCCESS" ? "Paid" : "Unpaid";
}

const COLUMNS = ["name", "reference_number", "student_id", "level", "phone", "email", "payment_status", "registered_via"];

export function studentsToCsv(students: ExportStudent[]): string {
  const data = students.map((s) => [
    safeCell(s.fullName),
    safeCell(s.referenceNumber),
    safeCell(s.studentIndexNo),
    s.level.replace("L", ""),
    safeCell(s.phone),
    safeCell(s.email),
    statusLabel(s),
    s.registrationSource === "SELF" ? "Self-registered" : "Added by admin",
  ]);
  // BOM so Excel opens it as UTF-8 (names with accents) instead of guessing.
  // fields + data (not objects) so an empty result still gets a header row.
  return "\uFEFF" + Papa.unparse({ fields: COLUMNS, data });
}

export function exportFilename(parts: { departmentName: string; level?: string | null; paymentStatus?: string | null; exempt?: string | null; search?: string | null }) {
  const slug = (t: string) => t.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  const bits = ["students", slug(parts.departmentName) || "department"];
  if (parts.level) bits.push(parts.level.toLowerCase());
  if (parts.paymentStatus === "SUCCESS") bits.push("paid");
  else if (parts.paymentStatus === "PENDING") bits.push("unpaid");
  if (parts.exempt === "true") bits.push("dues-cleared");
  if (parts.search) bits.push("search");
  bits.push(new Date().toISOString().slice(0, 10));
  return bits.join("_") + ".csv";
}
