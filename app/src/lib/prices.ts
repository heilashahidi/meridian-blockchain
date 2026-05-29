import { MAG7, TICKER_BY_FEED_ID } from "./feeds";

// Live Pyth Hermes price client. We use the plain HTTP "latest price" endpoint
// to keep the dependency surface small and the parsing testable. Equity feeds
// are only fresh during US market hours; off-hours the publish_time goes stale
// but the call still succeeds — the UI surfaces staleness via `publishTime`, it
// never throws. The `usePrices` polling hook lives in `@/hooks/usePrices`.

/** Public Hermes endpoint; override with NEXT_PUBLIC_HERMES_URL. */
export const HERMES_URL =
  process.env.NEXT_PUBLIC_HERMES_URL ?? "https://hermes.pyth.network";

export interface PriceData {
  /** Spot price in USD (already scaled by the feed exponent). */
  price: number;
  /** Confidence interval in USD (scaled). */
  confidence: number;
  /** Unix seconds of the price publish time. */
  publishTime: number;
}

/** ticker → latest price (or null if that feed was missing/unparseable). */
export type PriceMap = Record<string, PriceData | null>;

/**
 * Human "freshness" label for a price's publish time: "live" (<1m), then
 * "Nm/Nh/Nd ago", or "no data" when absent. Equity feeds only publish during
 * US market hours, so off-hours this surfaces the staleness.
 */
export function priceAgeLabel(p: PriceData | null): string {
  if (!p) return "no data";
  const ageSec = Math.max(0, Math.floor(Date.now() / 1000) - p.publishTime);
  if (ageSec < 60) return "live";
  if (ageSec < 3600) return `${Math.floor(ageSec / 60)}m ago`;
  if (ageSec < 86400) return `${Math.floor(ageSec / 3600)}h ago`;
  return `${Math.floor(ageSec / 86400)}d ago`;
}

/** The shape of one entry in a Hermes `/v2/updates/price/latest?parsed=true` response. */
interface HermesParsedEntry {
  id?: string;
  price?: {
    price?: string | number;
    conf?: string | number;
    expo?: number;
    publish_time?: number;
    publishTime?: number;
  };
}

/**
 * Pure parse: turn a Hermes parsed-price array into a ticker→PriceData map for
 * the MAG7 feeds. Tolerates missing/malformed feeds (those tickers map to
 * null); never throws. Unknown ids are ignored. Each known ticker always
 * appears as a key (defaulting to null) so callers can render a stable grid.
 */
export function parseHermesPrices(parsed: unknown): PriceMap {
  const out: PriceMap = {};
  for (const f of MAG7) out[f.ticker] = null;

  if (!Array.isArray(parsed)) return out;

  for (const raw of parsed as HermesParsedEntry[]) {
    const id = typeof raw?.id === "string" ? raw.id.toLowerCase() : null;
    if (!id) continue;
    const ticker = TICKER_BY_FEED_ID[id.startsWith("0x") ? id.slice(2) : id];
    if (!ticker) continue;

    const p = raw.price;
    if (!p) continue;

    const rawPrice = Number(p.price);
    const rawConf = Number(p.conf ?? 0);
    const expo = typeof p.expo === "number" ? p.expo : 0;
    const publishTime = Number(p.publish_time ?? p.publishTime ?? 0);

    if (!Number.isFinite(rawPrice) || !Number.isFinite(publishTime)) continue;

    const scale = Math.pow(10, expo);
    out[ticker] = {
      price: rawPrice * scale,
      confidence: (Number.isFinite(rawConf) ? rawConf : 0) * scale,
      publishTime,
    };
  }

  return out;
}

/** Build the Hermes latest-price URL for the given (hex, no-0x) feed ids. */
export function hermesLatestUrl(
  ids: readonly string[],
  base: string = HERMES_URL,
): string {
  const root = base.replace(/\/+$/, "");
  const params = ids.map((id) => `ids[]=${encodeURIComponent(id)}`).join("&");
  return `${root}/v2/updates/price/latest?${params}&parsed=true&encoding=hex`;
}

/**
 * Fetch the latest MAG7 prices once. Returns a full ticker→PriceData|null map.
 * Never throws — a network/parse failure yields an all-null map.
 */
export async function fetchPrices(
  base: string = HERMES_URL,
  signal?: AbortSignal,
): Promise<PriceMap> {
  const ids = MAG7.map((f) => f.feedId);
  try {
    const res = await fetch(hermesLatestUrl(ids, base), { signal });
    if (!res.ok) return parseHermesPrices(null);
    const body = (await res.json()) as { parsed?: unknown };
    return parseHermesPrices(body?.parsed);
  } catch {
    return parseHermesPrices(null);
  }
}
