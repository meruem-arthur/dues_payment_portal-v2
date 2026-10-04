-- System-wide Contact Support email/phone (single row, id = 'singleton').

-- CreateTable
CREATE TABLE "support_settings" (
    "id" TEXT NOT NULL DEFAULT 'singleton',
    "email" TEXT,
    "phone" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "support_settings_pkey" PRIMARY KEY ("id")
);
