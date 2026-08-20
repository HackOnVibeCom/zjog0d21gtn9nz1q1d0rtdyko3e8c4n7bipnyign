-- CreateTable
CREATE TABLE "DemoRun" (
    "id" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "appId" TEXT NOT NULL,
    "storeUrl" TEXT NOT NULL,
    "stage" TEXT NOT NULL DEFAULT 'importing',
    "failedAt" TEXT,
    "errorCode" TEXT,
    "listing" TEXT,
    "analysis" TEXT,
    "discovery" TEXT,
    "proposal" TEXT,
    "activeAt" TIMESTAMP(3),
    "executionId" TEXT,

    CONSTRAINT "DemoRun_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "DemoRun_sessionId_createdAt_idx" ON "DemoRun"("sessionId", "createdAt");

-- CreateIndex
CREATE INDEX "DemoRun_createdAt_idx" ON "DemoRun"("createdAt");
