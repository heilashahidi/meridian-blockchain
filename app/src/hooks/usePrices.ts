"use client";

import { useEffect, useRef, useState } from "react";

import {
  fetchPrices,
  HERMES_URL,
  parseHermesPrices,
  type PriceData,
  type PriceMap,
} from "@/lib/prices";

// Re-export the price types so consumers can import them alongside `usePrices`.
export type { PriceData, PriceMap };

const POLL_MS = 5000;

/**
 * React hook: poll Hermes for the latest MAG7 prices. Returns the current map
 * (all-null until the first successful fetch). Tolerates failures; keeps the
 * last good map on a transient error.
 */
export function usePrices(): PriceMap {
  const [prices, setPrices] = useState<PriceMap>(() => parseHermesPrices(null));
  const lastGood = useRef<PriceMap>(prices);

  useEffect(() => {
    let cancelled = false;
    const controller = new AbortController();

    async function tick() {
      const next = await fetchPrices(HERMES_URL, controller.signal);
      if (cancelled) return;
      // Keep the last good price for any feed that came back null this round.
      const merged: PriceMap = { ...next };
      for (const t of Object.keys(merged)) {
        if (merged[t] === null && lastGood.current[t]) {
          merged[t] = lastGood.current[t];
        }
      }
      lastGood.current = merged;
      setPrices(merged);
    }

    void tick();
    const interval = setInterval(() => void tick(), POLL_MS);
    return () => {
      cancelled = true;
      controller.abort();
      clearInterval(interval);
    };
  }, []);

  return prices;
}
