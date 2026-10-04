import { z } from "zod";

// Super admin's Contact Support destination (Settings page). A blank value
// clears that channel; the other channel keeps working on its own.
export const supportSettingsSchema = z.object({
  email: z.string().trim().email("Enter a valid email address").or(z.literal("")),
  phone: z.string().trim().min(9, "Enter a valid phone number").max(20).or(z.literal("")),
});

// Public Contact Support form (student side). Reference number is trimmed for
// the same reason as everywhere else: it's matched with exact equality.
export const supportRequestSchema = z.object({
  departmentSlug: z.string().min(1),
  referenceNumber: z.string().trim().min(1).max(50),
  message: z.string().trim().min(5).max(1000),
});
