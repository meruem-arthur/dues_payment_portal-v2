/**
 * Finance-portal integration settings.
 *
 * The finance portal is a separate app for ONE department. Departments in
 * this system are per academic session (unique on [academicSessionId, code]),
 * so the finance portal is bound to a department CODE (e.g. "GESA"), never a
 * department id - an id would change every time the department is set up for
 * a new session.
 *
 *  FINANCE_DEPARTMENT_CODE  department the finance portal belongs to
 *  FINANCE_API_KEY          bearer key the finance portal sends when pulling payments
 *  FINANCE_PUSH_TOKEN       shared secret: signs pushes to finance and sign-in handoff tokens
 *  FINANCE_PORTAL_URL       base URL of the deployed finance portal
 */
export type FinanceConfig = {
  departmentCode: string | null;
  apiKey: string | null;
  pushToken: string | null;
  portalUrl: string | null;
};

function clean(value: string | undefined): string | null {
  const v = value?.trim();
  return v ? v : null;
}

export function getFinanceConfig(): FinanceConfig {
  return {
    departmentCode: clean(process.env.FINANCE_DEPARTMENT_CODE),
    apiKey: clean(process.env.FINANCE_API_KEY),
    pushToken: clean(process.env.FINANCE_PUSH_TOKEN),
    portalUrl: clean(process.env.FINANCE_PORTAL_URL)?.replace(/\/+$/, "") ?? null,
  };
}

/** Pull API (finance -> dues) needs a department and an API key. */
export function isFinanceApiEnabled(c: FinanceConfig = getFinanceConfig()): boolean {
  return Boolean(c.departmentCode && c.apiKey);
}

/** Push (dues -> finance) needs a department, the shared token and the portal URL. */
export function isFinancePushEnabled(c: FinanceConfig = getFinanceConfig()): boolean {
  return Boolean(c.departmentCode && c.pushToken && c.portalUrl);
}

/** Sign-in handoff uses the same ingredients as the push. */
export function isFinanceSsoEnabled(c: FinanceConfig = getFinanceConfig()): boolean {
  return isFinancePushEnabled(c);
}

export function departmentCodesMatch(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return false;
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}
