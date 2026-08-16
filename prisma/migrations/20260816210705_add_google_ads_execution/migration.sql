-- CreateTable
CREATE TABLE "GoogleAdsExecution" (
    "id" TEXT NOT NULL,
    "executionType" TEXT NOT NULL DEFAULT 'app_campaign',
    "mode" TEXT NOT NULL,
    "userId" TEXT,
    "demoSessionId" TEXT,
    "projectId" TEXT,
    "provider" TEXT NOT NULL DEFAULT 'google_ads',
    "campaignId" TEXT,
    "campaignResourceName" TEXT,
    "campaignName" TEXT,
    "campaignBudgetResourceName" TEXT,
    "status" TEXT,
    "channelType" TEXT,
    "channelSubType" TEXT,
    "appId" TEXT,
    "dailyBudgetMicros" INTEGER,
    "result" TEXT NOT NULL DEFAULT 'pending',
    "errorCode" TEXT,
    "events" TEXT,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),
    "lastVerifiedAt" TIMESTAMP(3),

    CONSTRAINT "GoogleAdsExecution_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "GoogleAdsExecution_demoSessionId_idx" ON "GoogleAdsExecution"("demoSessionId");

-- CreateIndex
CREATE INDEX "GoogleAdsExecution_userId_idx" ON "GoogleAdsExecution"("userId");

