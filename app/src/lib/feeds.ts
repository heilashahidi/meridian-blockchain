// MAG7 ticker → Pyth feed metadata. These are the **regular-session** US equity
// feeds (`Equity.US.<TICKER>/USD`), which are only fresh during market hours
// (9:30AM–4PM ET, weekdays). Off-hours the feed is stale — the UI tolerates that
// (shows the last price / null), and settlement falls back to admin-override.
//
// Feed IDs are the canonical 64-hex Hermes price-feed ids (no `0x` prefix), each
// verified against `https://hermes.pyth.network/v2/price_feeds?query=<ticker>`
// by matching `attributes.symbol === "Equity.US.<TICKER>/USD"`.

export interface FeedInfo {
  /** Display ticker, e.g. "AAPL". */
  ticker: string;
  /** Company name for UI. */
  name: string;
  /** Pyth Hermes price-feed id (64 hex chars, no 0x prefix). */
  feedId: string;
  /** Canonical Pyth symbol. */
  symbol: string;
}

/** The seven "Magnificent Seven" stocks, in display order. */
export const MAG7: readonly FeedInfo[] = [
  {
    ticker: "AAPL",
    name: "Apple",
    feedId:
      "49f6b65cb1de6b10eaf75e7c03ca029c306d0357e91b5311b175084a5ad55688",
    symbol: "Equity.US.AAPL/USD",
  },
  {
    ticker: "MSFT",
    name: "Microsoft",
    feedId:
      "d0ca23c1cc005e004ccf1db5bf76aeb6a49218f43dac3d4b275e92de12ded4d1",
    symbol: "Equity.US.MSFT/USD",
  },
  {
    ticker: "GOOGL",
    name: "Alphabet",
    feedId:
      "5a48c03e9b9cb337801073ed9d166817473697efff0d138874e0f6a33d6d5aa6",
    symbol: "Equity.US.GOOGL/USD",
  },
  {
    ticker: "AMZN",
    name: "Amazon",
    feedId:
      "b5d0e0fa58a1f8b81498ae670ce93c872d14434b72c364885d4fa1b257cbb07a",
    symbol: "Equity.US.AMZN/USD",
  },
  {
    ticker: "NVDA",
    name: "NVIDIA",
    feedId:
      "b1073854ed24cbc755dc527418f52b7d271f6cc967bbf8d8129112b18860a593",
    symbol: "Equity.US.NVDA/USD",
  },
  {
    ticker: "META",
    name: "Meta Platforms",
    feedId:
      "78a3e3b8e676a8f73c439f5d749737034b139bbbe899ba5775216fba596607fe",
    symbol: "Equity.US.META/USD",
  },
  {
    ticker: "TSLA",
    name: "Tesla",
    feedId:
      "16dad506d7db8da01c87581c87ca897a012a153557d4d578c3b9c9e1bc0632f1",
    symbol: "Equity.US.TSLA/USD",
  },
] as const;

/** All MAG7 ticker symbols, in display order. */
export const MAG7_TICKERS: readonly string[] = MAG7.map((f) => f.ticker);

/** ticker → feed id (lowercased, no `0x`). */
export const FEED_ID_BY_TICKER: Readonly<Record<string, string>> =
  Object.fromEntries(MAG7.map((f) => [f.ticker, f.feedId]));

/** feed id → ticker. Hermes returns ids without the `0x` prefix. */
export const TICKER_BY_FEED_ID: Readonly<Record<string, string>> =
  Object.fromEntries(MAG7.map((f) => [f.feedId, f.ticker]));

/** Look up the ticker for a Hermes feed id, tolerating an optional `0x` prefix. */
export function tickerForFeedId(id: string): string | null {
  const norm = id.startsWith("0x") ? id.slice(2) : id;
  return TICKER_BY_FEED_ID[norm.toLowerCase()] ?? null;
}
