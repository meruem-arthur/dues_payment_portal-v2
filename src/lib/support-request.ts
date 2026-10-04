import { prisma } from "@/lib/db";
import { getSmsProvider } from "@/lib/sms/provider-factory";
import { getEmailProvider } from "@/lib/email/provider-factory";
import { decryptSmsApiKey } from "@/lib/crypto/field-encryption";
import { captureError } from "@/lib/monitoring/capture-error";

export const SUPPORT_SETTINGS_ID = "singleton";

// An SMS is billed per ~160-character segment, so only the start of the
// student's message goes by SMS; the email carries all of it.
const SMS_MESSAGE_MAX_CHARS = 280;

type SmsConfigRow = {
  senderId: string;
  enabled: boolean;
  apiKey: string | null;
  username: string | null;
};

export type SupportRequestInput = {
  department: { id: string; name: string; code: string; smsConfig: SmsConfigRow | null };
  referenceNumber: string;
  message: string;
  student: { fullName: string; level: string; phone: string } | null;
};

export type SupportRequestResult =
  | { ok: true; emailSent: boolean; smsSent: boolean }
  | { ok: false; reason: "NOT_CONFIGURED" | "SEND_FAILED" };

type Outcome = "SENT" | "FAILED" | "SKIPPED";

const oneLine = (s: string) => s.replace(/\s+/g, " ").trim();

function levelLabel(level: string) {
  return level.replace(/^L(\d+)$/, "Level $1");
}

async function logOutcome(departmentId: string, channel: "SMS" | "EMAIL", recipient: string, outcome: Outcome, error?: string) {
  if (outcome === "SKIPPED") return;
  try {
    await prisma.notificationLog.create({
      data: {
        departmentId,
        channel,
        recipient,
        status: outcome === "SENT" ? "SENT" : "FAILED",
        errorMessage: error,
      },
    });
  } catch (err) {
    // Logging must never turn a delivered message into a failure.
    captureError(err, { context: "support-request-log" });
  }
}

/**
 * Sends a student's Contact Support message to the system-wide support email
 * and phone (see SupportSettings). Email goes through the shared email
 * provider; SMS goes through the SMS config of the department the student
 * was paying under, and is simply skipped if that department has none.
 *
 * Succeeds if at least one channel delivered - the student is only told
 * "sent" when a human can actually receive it.
 */
export async function sendSupportRequest(input: SupportRequestInput): Promise<SupportRequestResult> {
  const settings = await prisma.supportSettings.findUnique({ where: { id: SUPPORT_SETTINGS_ID } });
  const supportEmail = settings?.email?.trim() || null;
  const supportPhone = settings?.phone?.trim() || null;
  if (!supportEmail && !supportPhone) return { ok: false, reason: "NOT_CONFIGURED" };

  const { department, student } = input;
  const reference = oneLine(input.referenceNumber);
  const message = input.message.trim();

  const emailTask = async (): Promise<Outcome> => {
    if (!supportEmail) return "SKIPPED";
    const lines = [
      "A student needs help with their dues payment.",
      "",
      `Department: ${department.name}`,
      `Reference number: ${reference}`,
      student
        ? `Student record: ${student.fullName} (${levelLabel(student.level)}), phone ${student.phone}`
        : "Student record: no student with this reference number in this department",
      "",
      "Issue described by the student:",
      message,
    ];
    const result = await getEmailProvider().send({
      to: supportEmail,
      subject: `Dues support request - Ref ${reference} (${department.name})`,
      body: lines.join("\n"),
    });
    await logOutcome(department.id, "EMAIL", supportEmail, result.success ? "SENT" : "FAILED", result.error);
    return result.success ? "SENT" : "FAILED";
  };

  const smsTask = async (): Promise<Outcome> => {
    const smsConfig = department.smsConfig;
    if (!supportPhone || !smsConfig || !smsConfig.enabled || !smsConfig.apiKey) return "SKIPPED";
    const shortMessage = oneLine(message).slice(0, SMS_MESSAGE_MAX_CHARS);
    const who = student ? ` (${student.fullName})` : "";
    const decrypted = decryptSmsApiKey(smsConfig);
    const result = await getSmsProvider().send(
      {
        to: supportPhone,
        message: `Dues support - ${department.code}\nRef ${reference}${who}:\n${shortMessage}`,
        senderId: decrypted.senderId,
      },
      { apiKey: decrypted.apiKey, username: decrypted.username }
    );
    await logOutcome(department.id, "SMS", supportPhone, result.success ? "SENT" : "FAILED", result.error);
    return result.success ? "SENT" : "FAILED";
  };

  // One channel throwing (network blip, bad key) must not stop the other.
  const settle = (task: () => Promise<Outcome>): Promise<Outcome> =>
    task().catch((err) => {
      captureError(err, { context: "support-request-send" });
      return "FAILED" as const;
    });
  const [email, sms] = await Promise.all([settle(emailTask), settle(smsTask)]);

  if (email !== "SENT" && sms !== "SENT") return { ok: false, reason: "SEND_FAILED" };
  return { ok: true, emailSent: email === "SENT", smsSent: sms === "SENT" };
}
