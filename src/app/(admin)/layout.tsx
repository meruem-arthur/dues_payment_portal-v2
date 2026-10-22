import { getServerSession } from "next-auth";
import { redirect } from "next/navigation";
import { authOptions } from "@/lib/auth";
import { AdminSidebar } from "@/components/admin/admin-sidebar";
import { resolveFinanceAccess } from "@/lib/finance/access";
import { getFinanceConfig, isFinanceSsoEnabled } from "@/lib/finance/config";

export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const session = await getServerSession(authOptions);
  if (!session?.user) redirect("/login");
  const user = session.user as any;

  // Show the Finance Portal link only when the integration is configured and
  // this admin may actually open it. Any failure just hides the link.
  let financeEnabled = false;
  if (isFinanceSsoEnabled(getFinanceConfig())) {
    try {
      financeEnabled = (await resolveFinanceAccess(user.id)).allowed;
    } catch {
      financeEnabled = false;
    }
  }

  return (
    <div className="admin-shell flex min-h-screen flex-col md:flex-row">
      <AdminSidebar userName={user.name} role={user.role} financeEnabled={financeEnabled} />
      <main className="flex-1 min-w-0 overflow-x-auto p-4 sm:p-8">{children}</main>
    </div>
  );
}
