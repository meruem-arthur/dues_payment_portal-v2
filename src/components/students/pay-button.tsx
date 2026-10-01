"use client";

import { useState } from "react";
import { Spinner } from "@/components/ui/spinner";
import { ReceiptActions } from "@/components/receipts/receipt-actions";

export function PayButton({
  departmentSlug,
  paymentType,
  autoOpen = false,
}: {
  departmentSlug: string;
  paymentType: "FRESHER" | "CONTINUING";
  // When the payment form is reached via a `?type=` deep link, the form
  // itself is the landing page - no reason to make the student click
  // "Pay Now" first just to see the fields they came here for.
  autoOpen?: boolean;
}) {
  const [open, setOpen] = useState(autoOpen);
  // Both student types now get a review step before anything is submitted.
  // Freshers aren't in the database yet, so their review just echoes back
  // what they typed (their one chance to catch a typo'd reference number
  // before it self-registers a new record). Continuing students already
  // exist, so instead of trusting what's typed, "confirm" looks their
  // record up and shows their real name from the DB - a genuine "is this
  // you?" check, not just a recap.
  // "cleared" is for a student a super admin has marked Dues Cleared: the
  // review screen says so and offers the receipt instead of "Confirm & Pay".
  const [step, setStep] = useState<"form" | "confirm" | "cleared">("form");
  const [receiptToken, setReceiptToken] = useState<string | null>(null);
  const [fullName, setFullName] = useState("");
  const [referenceNumber, setReferenceNumber] = useState("");
  const [phone, setPhone] = useState("");
  const [email, setEmail] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [lookingUp, setLookingUp] = useState(false);
  const isFresher = paymentType === "FRESHER";

  async function handleFormSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);

    // Trim once, here, and write the trimmed value back into state so the
    // confirm screen and the eventual /api/payments/initiate call both use
    // the same, clean value - a copy-pasted space is invisible on screen but
    // breaks an exact-match DB lookup. (The server also trims, but fixing it
    // here means the confirm step never echoes back a stray space either.)
    const cleanReferenceNumber = referenceNumber.trim();
    setReferenceNumber(cleanReferenceNumber);

    if (isFresher) {
      setStep("confirm");
      return;
    }

    // Continuing: look the student up first so the confirm screen can show
    // their actual name, not just whatever was typed.
    setLookingUp(true);
    try {
      const res = await fetch("/api/students/lookup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ departmentSlug, paymentType, referenceNumber: cleanReferenceNumber }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error ?? "Could not find that reference number");
        return;
      }
      setFullName(data.fullName);
      if (data.cleared && data.receiptToken) {
        setReceiptToken(data.receiptToken);
        setStep("cleared");
        return;
      }
      setStep("confirm");
    } catch {
      setError("Could not look up that reference number. Please try again.");
    } finally {
      setLookingUp(false);
    }
  }

  async function pay() {
    setLoading(true);
    setError(null);

    const res = await fetch("/api/payments/initiate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        departmentSlug,
        paymentType,
        referenceNumber,
        phone,
        email: email || undefined,
        ...(isFresher ? { fullName } : {}),
      }),
    });
    const data = await res.json();
    setLoading(false);

    if (!res.ok) {
      setError(data.error ?? "Something went wrong");
      setStep("form");
      return;
    }
    window.location.href = data.authorizationUrl;
  }

  function reset() {
    setOpen(autoOpen);
    setStep("form");
    setReceiptToken(null);
    setError(null);
  }

  if (!open) {
    return (
      <button className="portal-btn-primary w-full" onClick={() => setOpen(true)}>
        Pay Now
      </button>
    );
  }

  if (step === "cleared" && receiptToken) {
    return (
      <div className="space-y-3 text-left">
        <div className="rounded-md border border-portal-border p-3">
          <p className="text-sm font-semibold text-portal-text">Dues Cleared</p>
          <p className="mt-1 text-xs text-portal-muted">No payment is needed. Continue only if this is you.</p>
          <dl className="mt-3 space-y-1.5 text-sm">
            <div className="flex justify-between gap-3">
              <dt className="text-portal-muted">Full Name</dt>
              <dd className="text-portal-text">{fullName}</dd>
            </div>
            <div className="flex justify-between gap-3">
              <dt className="text-portal-muted">Reference Number</dt>
              <dd className="text-portal-text">{referenceNumber}</dd>
            </div>
          </dl>
        </div>
        <ReceiptActions
          downloadUrl={`/api/receipts/clearance?token=${encodeURIComponent(receiptToken)}`}
          fileName="dues-clearance-receipt.pdf"
        />
        <button type="button" className="portal-btn-secondary w-full" onClick={() => setStep("form")}>
          Edit Details
        </button>
      </div>
    );
  }

  if (step === "confirm") {
    return (
      <div className="space-y-3 text-left">
        {error && <p className="rounded-md bg-red-950 px-3 py-2 text-sm text-red-400">{error}</p>}
        <div className="rounded-md border border-portal-border p-3">
          <p className="text-sm font-semibold text-portal-text">Confirm your details</p>
          <p className="mt-1 text-xs text-portal-muted">
            {isFresher
              ? `This creates your student record for ${departmentSlug.replace(/-/g, " ")}. Double-check these before you pay - especially your reference number.`
              : "Continue only if this is you."}
          </p>
          <dl className="mt-3 space-y-1.5 text-sm">
            <div className="flex justify-between gap-3">
              <dt className="text-portal-muted">Full Name</dt>
              <dd className="text-portal-text">{fullName}</dd>
            </div>
            <div className="flex justify-between gap-3">
              <dt className="text-portal-muted">Reference Number</dt>
              <dd className="text-portal-text">{referenceNumber}</dd>
            </div>
            <div className="flex justify-between gap-3">
              <dt className="text-portal-muted">Phone</dt>
              <dd className="text-portal-text">{phone}</dd>
            </div>
            {email && (
              <div className="flex justify-between gap-3">
                <dt className="text-portal-muted">Email</dt>
                <dd className="text-portal-text">{email}</dd>
              </div>
            )}
          </dl>
        </div>
        <div className="flex flex-col gap-2">
          <button
            type="button"
            disabled={loading}
            onClick={() => void pay()}
            className="portal-btn-primary flex w-full items-center justify-center gap-2"
          >
            {loading && <Spinner />}
            {loading ? "Redirecting..." : "Confirm & Pay"}
          </button>
          <button type="button" className="portal-btn-secondary w-full" disabled={loading} onClick={() => setStep("form")}>
            Edit Details
          </button>
        </div>
      </div>
    );
  }

  return (
    <form onSubmit={handleFormSubmit} className="space-y-3 text-left">
      {error && <p className="rounded-md bg-red-950 px-3 py-2 text-sm text-red-400">{error}</p>}
      {isFresher && (
        <div>
          <label className="text-sm text-muted">Full Name</label>
          <input required className="portal-input" value={fullName} onChange={(e) => setFullName(e.target.value)} />
        </div>
      )}
      <div>
        <label className="text-sm text-muted">Reference Number</label>
        <input required className="portal-input" value={referenceNumber} onChange={(e) => setReferenceNumber(e.target.value)} />
        {isFresher && (
          <p className="mt-1 text-xs text-portal-muted">Use the reference number you were given on admission.</p>
        )}
      </div>
      <div>
        <label className="text-sm text-muted">Phone Number</label>
        <input required className="portal-input" value={phone} onChange={(e) => setPhone(e.target.value)} />
      </div>
      <div>
        <label className="text-sm text-muted">Email (optional)</label>
        <input className="portal-input" value={email} onChange={(e) => setEmail(e.target.value)} />
      </div>
      <div className="flex flex-col gap-2">
        <button type="submit" disabled={lookingUp} className="portal-btn-primary flex w-full items-center justify-center gap-2">
          {lookingUp && <Spinner />}
          {lookingUp ? "Checking..." : "Review Details"}
        </button>
        <button type="button" className="portal-btn-secondary w-full" onClick={reset}>Cancel</button>
      </div>
    </form>
  );
}
