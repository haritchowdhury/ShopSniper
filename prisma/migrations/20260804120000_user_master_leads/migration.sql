CREATE TABLE "UserShop" (
  "id" TEXT NOT NULL, "userId" TEXT NOT NULL, "shopId" TEXT NOT NULL,
  "firstDiscoveredAt" TIMESTAMP(3) NOT NULL, "lastDiscoveredAt" TIMESTAMP(3) NOT NULL,
  "firstDiscoveredRunId" TEXT NOT NULL, "lastDiscoveredRunId" TEXT NOT NULL,
  "discoveryCount" INTEGER NOT NULL DEFAULT 1, "lifecycleStatus" TEXT,
  "notes" TEXT, "tags" TEXT[] DEFAULT ARRAY[]::TEXT[], "archivedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL, CONSTRAINT "UserShop_pkey" PRIMARY KEY ("id")
);
CREATE TABLE "UserShopDiscovery" (
  "id" TEXT NOT NULL, "userShopId" TEXT NOT NULL, "runId" TEXT NOT NULL,
  "leadId" TEXT, "discoveredAt" TIMESTAMP(3) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "UserShopDiscovery_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "UserShop_userId_shopId_key" ON "UserShop"("userId", "shopId");
CREATE INDEX "UserShop_userId_lastDiscoveredAt_idx" ON "UserShop"("userId", "lastDiscoveredAt");
CREATE INDEX "UserShop_userId_lifecycleStatus_idx" ON "UserShop"("userId", "lifecycleStatus");
CREATE INDEX "UserShop_shopId_idx" ON "UserShop"("shopId");
CREATE UNIQUE INDEX "UserShopDiscovery_userShopId_runId_key" ON "UserShopDiscovery"("userShopId", "runId");
CREATE INDEX "UserShopDiscovery_runId_idx" ON "UserShopDiscovery"("runId");
CREATE INDEX "UserShopDiscovery_userShopId_discoveredAt_idx" ON "UserShopDiscovery"("userShopId", "discoveredAt");
ALTER TABLE "UserShop" ADD CONSTRAINT "UserShop_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "UserShopDiscovery" ADD CONSTRAINT "UserShopDiscovery_userShopId_fkey" FOREIGN KEY ("userShopId") REFERENCES "UserShop"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "UserShopDiscovery" ADD CONSTRAINT "UserShopDiscovery_runId_fkey" FOREIGN KEY ("runId") REFERENCES "Run"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

WITH owned AS (
  SELECT DISTINCT r."ownerId" "userId", l."shopId", r."id" "runId", l."id" "leadId", r."createdAt" "discoveredAt"
  FROM "Lead" l JOIN "Run" r ON r."id" = l."runId"
  WHERE r."ownerId" IS NOT NULL AND l."shopId" IS NOT NULL
), grouped AS (
  SELECT "userId", "shopId", MIN("discoveredAt") "firstAt", MAX("discoveredAt") "lastAt",
    (ARRAY_AGG("runId" ORDER BY "discoveredAt", "runId"))[1] "firstRun",
    (ARRAY_AGG("runId" ORDER BY "discoveredAt" DESC, "runId" DESC))[1] "lastRun",
    COUNT(*)::INTEGER "runCount" FROM owned GROUP BY "userId", "shopId"
)
INSERT INTO "UserShop" ("id", "userId", "shopId", "firstDiscoveredAt", "lastDiscoveredAt", "firstDiscoveredRunId", "lastDiscoveredRunId", "discoveryCount", "updatedAt")
SELECT 'user_shop_' || MD5("userId" || ':' || "shopId"), "userId", "shopId", "firstAt", "lastAt", "firstRun", "lastRun", "runCount", CURRENT_TIMESTAMP FROM grouped;

WITH owned AS (
  SELECT DISTINCT ON (r."ownerId", l."shopId", r."id") r."ownerId" "userId", l."shopId", r."id" "runId", l."id" "leadId", r."createdAt" "discoveredAt"
  FROM "Lead" l JOIN "Run" r ON r."id" = l."runId"
  WHERE r."ownerId" IS NOT NULL AND l."shopId" IS NOT NULL
  ORDER BY r."ownerId", l."shopId", r."id", l."id"
)
INSERT INTO "UserShopDiscovery" ("id", "userShopId", "runId", "leadId", "discoveredAt")
SELECT 'user_shop_discovery_' || MD5(us."id" || ':' || owned."runId"), us."id", owned."runId", owned."leadId", owned."discoveredAt"
FROM owned JOIN "UserShop" us ON us."userId" = owned."userId" AND us."shopId" = owned."shopId";
