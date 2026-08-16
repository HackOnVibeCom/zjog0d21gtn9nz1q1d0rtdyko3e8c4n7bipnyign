-- CreateTable
CREATE TABLE "DemoSession" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "clientHash" TEXT,
    "executionId" TEXT,

    CONSTRAINT "DemoSession_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "DemoSession_clientHash_createdAt_idx" ON "DemoSession"("clientHash", "createdAt");

-- CreateIndex
CREATE INDEX "DemoSession_createdAt_idx" ON "DemoSession"("createdAt");

