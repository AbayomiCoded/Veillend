export function shortenAddress(address: string, start = 6, end = 4): string {
  if (!address) return '';
  return `${address.slice(0, start)}...${address.slice(-end)}`;
}

const CURRENCY_SYMBOLS: Record<string, string> = { USD: '$', EUR: '€', GBP: '£' };

export function getCurrencySymbol(currency: string): string {
  return CURRENCY_SYMBOLS[currency] ?? '$';
}

// Ionicons fallback per known asset symbol. Screens prefer asset.logoUrl when
// the backend provides one.
const ASSET_ICONS: Record<string, string> = {
  XLM: 'star',
  USDC: 'logo-usd',
  BLND: 'layers',
  BTC: 'logo-bitcoin',
  ETH: 'logo-ethereum',
  EURT: 'logo-euro',
};

export function getAssetIcon(symbol: string): string {
  return ASSET_ICONS[symbol?.toUpperCase()] ?? 'cube-outline';
}
