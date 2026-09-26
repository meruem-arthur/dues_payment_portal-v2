-- Distinguish self-registered fresher records (created by the public
-- payment form, see /api/payments/initiate) from admin-created ones
-- (manual add / CSV import), so financial secretaries can review the
-- unverified intake in the admin student list.
--
-- Every existing row is, by definition, admin-created - self-registration
-- didn't exist before this migration - so ADMIN as the default and backfill
-- value is correct for all current data, not just a placeholder.

-- CreateEnum
CREATE TYPE "StudentRegistrationSource" AS ENUM ('ADMIN', 'SELF');

-- AlterTable
ALTER TABLE "students" ADD COLUMN "registrationSource" "StudentRegistrationSource" NOT NULL DEFAULT 'ADMIN';
