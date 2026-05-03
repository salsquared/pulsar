-- CreateTable
CREATE TABLE "Asset" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "symbol" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "assetClass" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true
);

-- CreateTable
CREATE TABLE "PriceTick" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "assetId" TEXT NOT NULL,
    "timestamp" DATETIME NOT NULL,
    "open" REAL,
    "high" REAL,
    "low" REAL,
    "close" REAL NOT NULL,
    "volume" REAL,
    "source" TEXT NOT NULL,
    CONSTRAINT "PriceTick_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES "Asset" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "DailySummary" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "assetId" TEXT NOT NULL,
    "date" DATETIME NOT NULL,
    "open" REAL NOT NULL,
    "high" REAL NOT NULL,
    "low" REAL NOT NULL,
    "close" REAL NOT NULL,
    "volume" REAL,
    CONSTRAINT "DailySummary_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES "Asset" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "MacroSeries" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "seriesId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "value" REAL NOT NULL,
    "timestamp" DATETIME NOT NULL,
    "source" TEXT NOT NULL
);

-- CreateTable
CREATE TABLE "IngestJob" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "sourceId" TEXT NOT NULL,
    "startedAt" DATETIME NOT NULL,
    "completedAt" DATETIME,
    "status" TEXT NOT NULL,
    "rowsInserted" INTEGER NOT NULL DEFAULT 0,
    "errorMsg" TEXT
);

-- CreateIndex
CREATE INDEX "PriceTick_assetId_timestamp_idx" ON "PriceTick"("assetId", "timestamp");

-- CreateIndex
CREATE UNIQUE INDEX "PriceTick_assetId_timestamp_source_key" ON "PriceTick"("assetId", "timestamp", "source");

-- CreateIndex
CREATE INDEX "DailySummary_assetId_date_idx" ON "DailySummary"("assetId", "date");

-- CreateIndex
CREATE UNIQUE INDEX "DailySummary_assetId_date_key" ON "DailySummary"("assetId", "date");

-- CreateIndex
CREATE INDEX "MacroSeries_seriesId_timestamp_idx" ON "MacroSeries"("seriesId", "timestamp");

-- CreateIndex
CREATE UNIQUE INDEX "MacroSeries_seriesId_timestamp_key" ON "MacroSeries"("seriesId", "timestamp");
