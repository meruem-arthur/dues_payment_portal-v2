"use client";

import { useState } from "react";
import { Spinner } from "@/components/ui/spinner";

/**
 * Super-admin form for the system-wide Contact Support destination. Student
 * support messages from every department go to this email (shared email
 * sender) and this phone number (SMS via the student's own department's SMS
 * setup). Leave a field blank to turn that channel off.
 */
export function SupportContactForm({ initialEmail, initialPhone }: { initialEmail: string; initialPhone: string }) {
  const [email, setEmail] = useState(initialEmail);
  const [phone, setPhone] = useState(initialPhone);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSuccess(false);
    setLoading(true);
    try {
      const res = await fetch("/api/settings/support", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, phone }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(data.error ?? "Something went wrong. Please try again.");
        return;
      }
      setEmail(data.email ?? "");
      setPhone(data.phone ?? "");
      setSuccess(true);
    } finally {
      setLoading(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="admin-card max-w-md space-y-4 p-6">
      {error && (
        <p className="rounded-md border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-300">{error}</p>
      )}
      {success && (
        <p className="rounded-md border border-emerald-500/30 bg-emerald-500/10 px-3 py-2 text-sm text-emerald-300">
          Support contact saved.
        </p>
      )}

      <p className="text-sm text-admin-muted">
        Student Contact Support messages from every department are sent here. Leave a field blank to turn that channel
        off.
      </p>

      <div className="space-y-1">
        <label className="text-sm font-medium text-admin-text" htmlFor="support-email">
          Support email
        </label>
        <input
          id="support-email"
          type="email"
          className="admin-input"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="support@example.com"
          autoComplete="off"
        />
      </div>

      <div className="space-y-1">
        <label className="text-sm font-medium text-admin-text" htmlFor="support-phone">
          Support phone number
        </label>
        <input
          id="support-phone"
          type="tel"
          className="admin-input"
          value={phone}
          onChange={(e) => setPhone(e.target.value)}
          placeholder="0551234567"
          autoComplete="off"
        />
        <p className="text-xs text-admin-muted">
          The SMS is sent with the SMS setup of the department the student was paying under.
        </p>
      </div>

      <button type="submit" disabled={loading} className="admin-btn-primary flex w-full items-center justify-center gap-2">
        {loading && <Spinner />}
        {loading ? "Saving..." : "Save support contact"}
      </button>
    </form>
  );
}
