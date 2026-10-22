# Finance portal integration

An optional companion app (`finance_portal`) gives the financial secretary a live view of dues income. It is inert until the four `FINANCE_*` variables in `.env.example` are set.

## What this portal exposes

- `GET /api/finance/payments` - read-only feed of SUCCESS/REFUNDED payments for `FINANCE_DEPARTMENT_CODE`, paged by an `(updatedAt, id)` cursor so later corrections are picked up. Bearer `FINANCE_API_KEY`. No student personal data is included.
- `GET /api/finance/summary` - totals the finance portal uses to detect drift.
- Real-time push: `confirmSuccessfulPayment` sends a signed event to the finance portal after the response. Anything that later sets a payment to REFUNDED should call `queueFinancePush(paymentId)` from `src/lib/finance/push.ts`.
- `GET /api/finance/sso` - sign-in handoff (60-second signed token in the URL fragment). The "Finance Portal" sidebar link uses it; super admins and admins of the finance department only.

## Why a department CODE

Departments here are per academic session (unique on `[academicSessionId, code]`), so the same department gets a new row every session. The finance portal is bound to the code (e.g. `GESA`), which stays the same across sessions.

## Setup

1. Pick `FINANCE_DEPARTMENT_CODE` (must match the department's `code`).
2. Generate two secrets: `openssl rand -hex 32` for `FINANCE_API_KEY` and again for `FINANCE_PUSH_TOKEN`.
3. Set `FINANCE_PORTAL_URL` to the finance portal's URL.
4. Put the same values in the finance portal as `DUES_API_KEY` and `DUES_PUSH_TOKEN`, and `DEPARTMENT_CODE` = `FINANCE_DEPARTMENT_CODE`.
5. Redeploy. The "Finance Portal" link appears in the admin sidebar.
