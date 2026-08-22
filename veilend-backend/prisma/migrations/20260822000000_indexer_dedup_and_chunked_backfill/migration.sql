-- Drop the single-column unique index on TransactionHistory(txHash) if it exists
DROP INDEX IF EXISTS "TransactionHistory_txHash_key";

-- AlterTable TransactionHistory: add eventIndex
ALTER TABLE "TransactionHistory" ADD COLUMN IF NOT EXISTS "eventIndex" INTEGER;

-- Create composite unique index on (txHash, eventIndex)
CREATE UNIQUE INDEX IF NOT EXISTS "TransactionHistory_txHash_eventIndex_key" ON "TransactionHistory"("txHash", "eventIndex");

-- CreateTable IndexerEventDedup
CREATE TABLE IF NOT EXISTS "IndexerEventDedup" (
    "id" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "txHash" TEXT,
    "eventIndex" INTEGER,
    "ledger" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "IndexerEventDedup_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "IndexerEventDedup_eventId_key" ON "IndexerEventDedup"("eventId");
CREATE INDEX IF NOT EXISTS "IndexerEventDedup_expiresAt_idx" ON "IndexerEventDedup"("expiresAt");
CREATE INDEX IF NOT EXISTS "IndexerEventDedup_eventId_idx" ON "IndexerEventDedup"("eventId");
CREATE INDEX IF NOT EXISTS "IndexerEventDedup_txHash_eventIndex_idx" ON "IndexerEventDedup"("txHash", "eventIndex");
