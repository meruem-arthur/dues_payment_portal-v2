-- "Dues Cleared" (exempt) students and clearance receipts.

-- CreateEnum
CREATE TYPE "ReceiptKind" AS ENUM ('PAYMENT', 'CLEARANCE');

-- AlterTable: students
ALTER TABLE "students"
  ADD COLUMN "isExempt" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "exemptReason" TEXT,
  ADD COLUMN "exemptedAt" TIMESTAMP(3),
  ADD COLUMN "exemptedById" TEXT;

-- AlterTable: receipts (existing rows become kind = PAYMENT, unaffected)
ALTER TABLE "receipts"
  ALTER COLUMN "paymentId" DROP NOT NULL,
  ADD COLUMN "kind" "ReceiptKind" NOT NULL DEFAULT 'PAYMENT',
  ADD COLUMN "voidedAt" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX "students_departmentId_isExempt_idx" ON "students"("departmentId", "isExempt");

-- CreateIndex
CREATE UNIQUE INDEX "receipts_studentId_kind_key" ON "receipts"("studentId", "kind");

-- AddForeignKey
ALTER TABLE "students" ADD CONSTRAINT "students_exemptedById_fkey" FOREIGN KEY ("exemptedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
