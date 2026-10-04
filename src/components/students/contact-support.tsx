"use client";

import { useState } from "react";
import { Spinner } from "@/components/ui/spinner";

/**
 * Student-facing "Contact support" button + inline form. Used in two places
 * on the public payment page: as a standing link under the dues cards, and
 * under any payment error (see pay-button.tsx), where the reference number
 * the student already typed is passed in as a prefill.
 */
export function ContactSupport({
  departmentSlug,
  defaultReferenceNumber = "",
  label = "Contact support",
  className = "",
}: {
  departmentSlug: string;
  defaultReferenceNumber?: string;
  label?: string;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const [referenceNumber, setReferenceNumber] = useState("");
  const [message, setMessage] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState(false);

  function openForm() {
    setReferenceNumber((current) => current || defaultReferenceNumber);
    setOpen(true);
  }

  function close() {
    setOpen(false);
    setError(null);
    if (sent) {
      setSent(false);
      setMessage("");
    }
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      const res = await fetch("/api/support/contact", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ departmentSlug, referenceNumber, message }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(data.error ?? "We couldn't send your message. Please try again.");
        return;
      }
      setSent(true);
    } catch {
      setError("We couldn't send your message. Check your connection and try again.");
    } finally {
      setLoading(false);
    }
  }

  if (!open) {
    return (
      <button
        type="button"
        onClick={openForm}
        className={`text-sm font-medium text-portal-accent underline underline-offset-2 ${className}`}
      >
        {label}
      </button>
    );
  }

  if (sent) {
    return (
      <div className={`space-y-3 rounded-md border border-portal-border p-3 text-left ${className}`} role="status">
        <p className="text-sm font-semibold text-portal-text">Message sent</p>
        <p className="text-xs text-portal-muted">
          Your message has been sent successfully. We&apos;ll look into it and get back to you soon.
        </p>
        <button type="button" className="portal-btn-secondary w-full" onClick={close}>
          Close
        </button>
      </div>
    );
  }

  return (
    <form
      onSubmit={handleSubmit}
      className={`space-y-3 rounded-md border border-portal-border p-3 text-left ${className}`}
    >
      <div>
        <p className="text-sm font-semibold text-portal-text">Contact support</p>
        <p className="mt-1 text-xs text-portal-muted">
          Tell us what went wrong with your payment and we&apos;ll look into it.
        </p>
      </div>
      {error && (
        <p role="alert" className="rounded-md bg-red-950 px-3 py-2 text-sm text-red-400">
          {error}
        </p>
      )}
      <div>
        <label className="text-sm text-muted" htmlFor={`support-ref-${departmentSlug}`}>
          Reference Number
        </label>
        <input
          id={`support-ref-${departmentSlug}`}
          required
          maxLength={50}
          className="portal-input"
          value={referenceNumber}
          onChange={(e) => setReferenceNumber(e.target.value)}
        />
      </div>
      <div>
        <label className="text-sm text-muted" htmlFor={`support-msg-${departmentSlug}`}>
          What went wrong?
        </label>
        <textarea
          id={`support-msg-${departmentSlug}`}
          required
          minLength={5}
          maxLength={1000}
          rows={4}
          className="portal-input"
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          placeholder="e.g. I paid but never got my receipt, or I keep seeing 'Could not initiate payment'."
        />
      </div>
      <div className="flex flex-col gap-2">
        <button type="submit" disabled={loading} className="portal-btn-primary flex w-full items-center justify-center gap-2">
          {loading && <Spinner />}
          {loading ? "Sending..." : "Send message"}
        </button>
        <button type="button" className="portal-btn-secondary w-full" disabled={loading} onClick={close}>
          Cancel
        </button>
      </div>
    </form>
  );
}
