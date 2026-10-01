# UMaT Multi-Department Student Payment Platform (MVP)

A multi-tenant departmental-dues payment platform. Architected so any number
of departments can operate independently on the same codebase, each with its
own students, payment provider account, SMS sender, and administrators.

## Tech stack

- Next.js 14 (App Router) + TypeScript
- Tailwind CSS
- PostgreSQL (Neon) + Prisma
- Auth.js (NextAuth) credentials provider, JWT sessions
- Zod validation, React Hook Form patterns
- Papa Parse for CSV import
- `qrcode` for payment-link QR generation
- Payment / SMS / Email providers built behind interfaces (see "Architecture")

## Architecture

```
AcademicSession
   └── Department (tenant boundary)
         ├── Students
         ├── Payments → Receipts
         ├── PaymentProviderConfiguration (own Paystack/Hubtel account)
         ├── SMSConfiguration
         ├── EmailConfiguration
         └── DepartmentAdmin users
```

**Isolation is enforced server-side**, not just hidden in the UI. Every
department-scoped route calls `requireDepartmentAccess()` /
`scopedDepartmentWhere()` from `src/lib/authorization.ts`. A
`DEPARTMENT_ADMIN`'s `departmentId` from their session always wins over
anything sent in a request body or query string.

**Payment providers are abstracted** (`src/lib/payments/provider.interface.ts`).
Only `paystack.provider.ts` contains Paystack-specific code. Adding Hubtel
later means writing `hubtel.provider.ts` and registering it in
`provider-factory.ts` — no other file changes.

**SMS and Email are abstracted** the same way and currently mocked
(`src/lib/sms/mock.provider.ts`, `src/lib/email/mock.provider.ts`) — they log
to the console until real credentials are supplied.

**Webhooks are the only authoritative payment-confirmation event.** The
browser redirect after payment (`/d/[slug]/payment-status`) is read-only UX.
`src/app/api/webhooks/paystack/route.ts`:
1. Verifies the HMAC signature using the *owning department's* secret.
2. Re-verifies the transaction directly against Paystack's API (defense in
   depth beyond signature checking).
3. Uses a `@@unique([provider, providerEventId])` DB constraint on
   `WebhookEvent` as the idempotency gate — a duplicate webhook is a no-op.
4. Only after confirmation does it call `issueReceiptAndNotify()`, which
   generates a unique receipt and attempts an SMS send. SMS failure is
   logged to `NotificationLog` and never reverts payment status.

**Student edit dialog** (`src/components/students/student-manager.tsx`) keeps
a local copy of form state. Opening "Edit" populates that local copy only;
"Cancel" discards it with zero network calls; only "Save Changes" calls the
`PATCH` endpoint. This was a named requirement in the spec (previous bug:
Cancel wiping data) and is structurally impossible here since Cancel never
touches `fetch`.

## Local setup

```bash
npm install
cp .env.example .env       # fill in DATABASE_URL and AUTH_SECRET at minimum
npx prisma migrate dev --name init
npm run prisma:seed
npm run dev
```

Seed creates:
- Academic session `2026/2027`
- Departments: Geomatic Engineering, Civil Engineering (with sample students)
- Super admin: `superadmin@umat.test` / `Password123!`
- Department admins: `geomatic-engineering-admin@umat.test`,
  `civil-engineering-admin@umat.test` (same password)

Public payment pages: `/d/geomatic-engineering`, `/d/civil-engineering`.

## Configuring a real payment provider

Payment credentials are **per-department**, stored server-side in
`PaymentProviderConfiguration` (never sent to the frontend — the department
detail API strips secrets down to booleans like `hasSecretKey`). For the MVP,
set them directly in the database (via Prisma Studio or a small admin form
you extend) rather than global env vars, since two departments may each have
their own Paystack account.

Webhook URL to register with Paystack (per account, since each department
may use a different Paystack account, but they all point at the same
endpoint — the department is resolved from the transaction reference):

```
https://your-domain.com/api/webhooks/paystack
```

## Dues Cleared (exempt) students

A **super admin** can mark a continuing student (Level 200-400) as *Dues Cleared*, e.g. a scholarship holder, with a required reason. Department admins and financial secretaries cannot; every control below is enforced server-side (403), not just hidden in the UI.

- **Student side:** the student still types their details and reviews them. The review screen says "Dues Cleared" and offers "View & Download Receipt (PDF)" instead of "Confirm & Pay". No payment or provider call happens, and `/api/payments/initiate` hard-blocks cleared students. Publicly the wording is always "Dues Cleared": "exempt" and the reason appear only in admin screens.
- **Receipt:** a clearance receipt (`CLR-<year>-000001`, its own series) is issued with no payment, amount or provider. It is emailed (PDF attached) only if the student has an email and the department's email setting is on; no SMS is sent. If it can't be sent, the super admin sees why and can still download the PDF from the student row.
- **Public download:** `/api/students/lookup` returns a ~15-minute token signed with `AUTH_SECRET`, redeemed at `GET /api/receipts/clearance?token=...`. There is no permanent public URL keyed by receipt number.
- **Rules:** refused for Level 100 students and for anyone with a successful or pending payment. Removing a clearance voids the receipt (kept, never deleted), so `/verify/[receiptNumber]` shows it as invalid. Every grant and removal is audited (`STUDENT_EXEMPTED`, `EXEMPTION_REMOVED`).
- **Admin APIs (super admin only):** `POST`/`DELETE /api/students/[id]/exempt`, `GET /api/students/[id]/clearance-receipt`, and `POST /api/students/[id]/resend-receipt` (resends the clearance email for a cleared student).
- **Dashboard:** exempt students are excluded from "Pending" and the expected total, but still count toward Total Students; a separate "Exempt" card shows the count (with a per-level breakdown). The students list supports an `exempt` filter.
- **Deploying:** needs the `20260930120000_student_dues_cleared` migration (runs automatically via `npm run build`) and `AUTH_SECRET` set.

## Deployment

- App: Vercel or Render.
- DB: Neon PostgreSQL — run `npx prisma migrate deploy` as part of your
  build/release step.
- Set `AUTH_SECRET`, `DATABASE_URL`, `NEXT_PUBLIC_APP_URL` in your host's
  environment variables. Never commit `.env`.

## What's implemented vs. stubbed (MVP scope)

Implemented: auth + RBAC, academic sessions, departments (create/edit/typed-
confirmation delete), department admins via seed/Prisma, student CRUD with
bug-safe edit/cancel, CSV import with dry-run preview + duplicate detection,
department isolation on every API route, payment provider abstraction with a
working Paystack implementation, idempotent webhook handling, receipt
generation, SMS abstraction (mocked), email abstraction (mocked), audit
logging, QR-coded public payment pages, responsive dark/green UI.

Intentionally stubbed per spec section 40/41 (documented, not built): Hubtel
provider, real SMS/email providers (swap the mock in the relevant
`provider-factory.ts` once you have credentials), PDF receipts, public
receipt verification, payment reminders, multi-admin-per-department,
financial report exports. All of these slot into the existing abstractions
without restructuring the app.

## Critical tests to run before go-live

- Open Edit Student → change nothing → Cancel → confirm DB row is byte-for-byte
  unchanged.
- Log in as a department admin → attempt to call
  `/api/students?departmentId=<other-dept-id>` and
  `/api/departments/<other-dept-id>` directly → confirm 403.
- Send the same Paystack webhook payload twice → confirm only one `Payment`
  row transitions to `SUCCESS` and only one `Receipt` is created.
