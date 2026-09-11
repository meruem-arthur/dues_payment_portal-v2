"use client";

import { useState } from "react";
import { Spinner } from "@/components/ui/spinner";

export function PayButton({
  departmentSlug,
  paymentType,
}: {
  departmentSlug: string;
  paymentType: "FRESHER" | "CONTINUING";
}) {
  const [open, setOpen] = useState(false);
  // Freshers get an extra "confirm" screen before we submit, since a typo'd
  // reference number for them doesn't fail with "no student found" the way
  // it does for continuing students - it just registers a new record. This
  // is their one chance to catch that before it happens.
  const [step, setStep] = useState<"form" | "confirm">("form");
  const [fullName, setFullName] = useState("");
  const [referenceNumber, setReferenceNumber] = useState("");
  const [phone, setPhone] = useState("");
  const [email, setEmail] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const isFresher = paymentType === "FRESHER";

  function handleFormSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (isFresher) {
      setStep("confirm");
      return;
    }
    void pay();
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
    setOpen(false);
    setStep("form");
    setError(null);
  }

  if (!open) {
    return (
      <button className="portal-btn-primary w-full" onClick={() => setOpen(true)}>
        Pay Now
      </button>
    );
  }

  if (step === "confirm") {
    return (
      <div className="space-y-3 text-left">
        {error && <p className="rounded-md bg-red-950 px-3 py-2 text-sm text-red-400">{error}</p>}
        <div className="rounded-md border border-portal-border p-3">
          <p className="text-sm font-semibold text-portal-text">Confirm your details</p>
          <p className="mt-1 text-xs text-portal-muted">
            This creates your student record for {departmentSlug.replace(/-/g, " ")}. Double-check
            these before you pay - especially your reference number.
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
        <button type="submit" disabled={loading} className="portal-btn-primary flex w-full items-center justify-center gap-2">
          {loading && <Spinner />}
          {loading ? "Redirecting..." : isFresher ? "Review Details" : "Continue to Pay"}
        </button>
        <button type="button" className="portal-btn-secondary w-full" onClick={reset}>Cancel</button>
      </div>
    </form>
  );
}
