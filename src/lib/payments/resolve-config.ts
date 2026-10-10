// Decides which payment credentials apply to a payment.
//
// A department can have a separate credential set per student type
// (PaymentTypeConfiguration: FRESHER / CONTINUING) so the two groups can pay
// into different provider accounts. The older single-row
// PaymentProviderConfiguration is the fallback: a department/type with no row
// of its own keeps using it, so a department can never end up with no
// credentials and the feature can be rolled back safely.
//
// Every code path that needs credentials (initiate, both webhooks, reconcile)
// goes through pickPaymentConfig - nothing else should read
// department.paymentConfig directly. The type always comes from the stored
// Payment row (or, at initiation, the validated request), never from anything
// a webhook sender controls.

export type PaymentTypeValue = "FRESHER" | "CONTINUING";

type DepartmentWithConfigs<TLegacy, TTyped> = {
  paymentConfig?: TLegacy | null;
  paymentTypeConfigs?: TTyped[] | null;
};

export function pickPaymentConfig<
  TLegacy,
  TTyped extends { paymentType: string }
>(
  department: DepartmentWithConfigs<TLegacy, TTyped>,
  paymentType: PaymentTypeValue | string
): TLegacy | TTyped | null {
  const own = department.paymentTypeConfigs?.find((c) => c.paymentType === paymentType);
  if (own) return own;
  return department.paymentConfig ?? null;
}
