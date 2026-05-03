import { PrismaClient } from '@prisma/client'

const prisma = new PrismaClient()

const SEED_ASSETS = [
  // Equities
  { id: 'AAPL',   symbol: 'AAPL',   name: 'Apple Inc.',              assetClass: 'EQUITY' as const,    source: 'yahoo' },
  { id: 'MSFT',   symbol: 'MSFT',   name: 'Microsoft Corp.',          assetClass: 'EQUITY' as const,    source: 'yahoo' },
  { id: 'GOOGL',  symbol: 'GOOGL',  name: 'Alphabet Inc.',            assetClass: 'EQUITY' as const,    source: 'yahoo' },
  { id: 'AMZN',   symbol: 'AMZN',   name: 'Amazon.com Inc.',          assetClass: 'EQUITY' as const,    source: 'yahoo' },
  { id: 'NVDA',   symbol: 'NVDA',   name: 'NVIDIA Corp.',             assetClass: 'EQUITY' as const,    source: 'yahoo' },
  { id: 'META',   symbol: 'META',   name: 'Meta Platforms Inc.',      assetClass: 'EQUITY' as const,    source: 'yahoo' },
  { id: 'TSLA',   symbol: 'TSLA',   name: 'Tesla Inc.',               assetClass: 'EQUITY' as const,    source: 'yahoo' },
  { id: 'SPY',    symbol: 'SPY',    name: 'SPDR S&P 500 ETF',         assetClass: 'EQUITY' as const,    source: 'yahoo' },
  { id: 'QQQ',    symbol: 'QQQ',    name: 'Invesco QQQ Trust',        assetClass: 'EQUITY' as const,    source: 'yahoo' },
  { id: '^GSPC',  symbol: 'SPX',    name: 'S&P 500 Index',            assetClass: 'EQUITY' as const,    source: 'yahoo' },
  { id: '^DJI',   symbol: 'DJIA',   name: 'Dow Jones Industrial Avg', assetClass: 'EQUITY' as const,    source: 'yahoo' },
  { id: '^IXIC',  symbol: 'COMP',   name: 'NASDAQ Composite',         assetClass: 'EQUITY' as const,    source: 'yahoo' },
  // Forex
  { id: 'EUR/USD', symbol: 'EURUSD', name: 'Euro / US Dollar',        assetClass: 'FOREX' as const,     source: 'exchangerate' },
  { id: 'GBP/USD', symbol: 'GBPUSD', name: 'British Pound / US Dollar', assetClass: 'FOREX' as const,  source: 'exchangerate' },
  { id: 'USD/JPY', symbol: 'USDJPY', name: 'US Dollar / Japanese Yen', assetClass: 'FOREX' as const,   source: 'exchangerate' },
  { id: 'USD/CHF', symbol: 'USDCHF', name: 'US Dollar / Swiss Franc',  assetClass: 'FOREX' as const,   source: 'exchangerate' },
  { id: 'AUD/USD', symbol: 'AUDUSD', name: 'Australian Dollar / USD',  assetClass: 'FOREX' as const,   source: 'exchangerate' },
  // Commodities (Yahoo futures tickers)
  { id: 'GC=F',   symbol: 'GC',    name: 'Gold Futures',              assetClass: 'COMMODITY' as const, source: 'yahoo' },
  { id: 'SI=F',   symbol: 'SI',    name: 'Silver Futures',            assetClass: 'COMMODITY' as const, source: 'yahoo' },
  { id: 'CL=F',   symbol: 'CL',    name: 'WTI Crude Oil Futures',     assetClass: 'COMMODITY' as const, source: 'yahoo' },
  { id: 'NG=F',   symbol: 'NG',    name: 'Natural Gas Futures',       assetClass: 'COMMODITY' as const, source: 'yahoo' },
] as const

async function main() {
  for (const asset of SEED_ASSETS) {
    await prisma.asset.upsert({
      where: { id: asset.id },
      create: { ...asset, active: true },
      update: { symbol: asset.symbol, name: asset.name, source: asset.source, active: true },
    })
  }
  console.log(`Seeded ${SEED_ASSETS.length} assets`)
}

main()
  .catch((err) => { console.error(err); process.exit(1) })
  .finally(() => prisma.$disconnect())
