-- Separate payment credentials per student type.
--
-- A department can now collect FRESHER dues and CONTINUING-student dues into
-- different provider accounts (e.g. two Paystack businesses). Each row of
-- payment_type_configurations is one full credential set for one
-- (department, paymentType).
--
-- Nothing changes for existing departments on deploy: every department's
-- current credentials are copied into BOTH of its rows below, so freshers and
-- continuing students keep paying into the same account until an admin
-- changes one of them. secretKey/webhookSecret are copied as-is - they are
-- already encrypted with ENCRYPTION_KEY and that encryption is not tied to a
-- row, so the copies decrypt exactly like the originals.
--
-- payment_provider_configurations is deliberately left untouched: it is the
-- fallback the app uses when a department/type has no row here, and keeping
-- it makes this migration safe to roll back.

-- CreateTable
CREATE TABLE "payment_type_configurations" (
    "id" TEXT NOT NULL,
    "departmentId" TEXT NOT NULL,
    "paymentType" "PaymentType" NOT NULL,
    "provider" "PaymentProviderType" NOT NULL DEFAULT 'PAYSTACK',
    "environment" "ProviderEnvironment" NOT NULL DEFAULT 'TEST',
    "publicKey" TEXT,
    "secretKey" TEXT,
    "webhookSecret" TEXT,
    "configValue" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "payment_type_configurations_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "payment_type_configurations_departmentId_paymentType_key" ON "payment_type_configurations"("departmentId", "paymentType");

-- AddForeignKey (RESTRICT, matching every other department child table)
ALTER TABLE "payment_type_configurations" ADD CONSTRAINT "payment_type_configurations_departmentId_fkey" FOREIGN KEY ("departmentId") REFERENCES "departments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Copy each department's current credentials into both of its type rows.
INSERT INTO "payment_type_configurations"
    ("id", "departmentId", "paymentType", "provider", "environment", "publicKey", "secretKey", "webhookSecret", "configValue", "createdAt", "updatedAt")
SELECT
    gen_random_uuid()::text,
    c."departmentId",
    t."paymentType",
    c."provider",
    c."environment",
    c."publicKey",
    c."secretKey",
    c."webhookSecret",
    c."configValue",
    CURRENT_TIMESTAMP,
    CURRENT_TIMESTAMP
FROM "payment_provider_configurations" c
CROSS JOIN (VALUES ('FRESHER'::"PaymentType"), ('CONTINUING'::"PaymentType")) AS t("paymentType")
ON CONFLICT ("departmentId", "paymentType") DO NOTHING;
