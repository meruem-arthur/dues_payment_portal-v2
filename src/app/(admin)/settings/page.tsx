import { getServerSession } from "next-auth";
import { redirect } from "next/navigation";
import { authOptions } from "@/lib/auth";
import { ChangePasswordForm } from "@/components/admin/change-password-form";
import { SupportContactForm } from "@/components/admin/support-contact-form";
import { prisma } from "@/lib/db";
import { SUPPORT_SETTINGS_ID } from "@/lib/support-request";

export default async function SettingsPage() {
  const session = await getServerSession(authOptions);
  if (!session?.user) redirect("/login");
  const user = session.user as any;
  // Contact Support destination is system-wide, so only the super admin
  // sees (and may change) it.
  const supportSettings =
    user.role === "SUPER_ADMIN" ? await prisma.supportSettings.findUnique({ where: { id: SUPPORT_SETTINGS_ID } }) : null;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="bg-gradient-to-r from-admin-accent to-fuchsia-400 bg-clip-text text-2xl font-extrabold uppercase tracking-tight text-transparent">
          Account Settings
        </h1>
        <p className="text-sm text-admin-muted">
          Signed in as {user.name} ({user.email})
        </p>
      </div>

      <div>
        <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-admin-muted">Change password</h2>
        <ChangePasswordForm />
      </div>

      {user.role === "SUPER_ADMIN" && (
        <div>
          <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-admin-muted">Student support contact</h2>
          <SupportContactForm initialEmail={supportSettings?.email ?? ""} initialPhone={supportSettings?.phone ?? ""} />
        </div>
      )}
    </div>
  );
}
