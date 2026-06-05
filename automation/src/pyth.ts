// pyth.ts — the SHARED Pyth helper U2 (settlement script) and U5 (settle job)
// build on. Two responsibilities:
//
//   1. fetchLatestPriceUpdate(feedId) — pull the latest update for a feed from
//      Hermes (`@pythnetwork/hermes-client`). Returns the base64 VAA blobs (for
//      posting) plus the parsed price (for logging / pre-checks / decisions).
//   2. postPriceUpdate(...) — post that update to a cluster via the Pyth Solana
//      receiver (`@pythnetwork/pyth-solana-receiver`), creating a
//      `PriceUpdateV2` account, and return the account pubkey that
//      `settle_market` references.
//
// Equity feeds are only fresh during US regular trading hours; callers (U5)
// inspect `publishTime`/staleness and fall back to admin-override off-hours.

import { HermesClient } from "@pythnetwork/hermes-client";
import { PythSolanaReceiver } from "@pythnetwork/pyth-solana-receiver";
import { AnchorProvider, Wallet } from "@coral-xyz/anchor";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";

/** Normalize a feed ID to the bare 64-hex form Hermes expects (no `0x`). */
export function normalizeFeedId(feedId: string): string {
  return feedId.startsWith("0x") ? feedId.slice(2) : feedId;
}

export interface ParsedPrice {
  /** Feed ID as returned by Hermes (no `0x`). */
  feedId: string;
  /** Raw integer price; multiply by 10^expo for the real value. */
  price: bigint;
  /** Confidence interval, same scale as `price`. */
  conf: bigint;
  /** Price exponent (e.g. -8). Real price = price * 10^expo. */
  expo: number;
  /** Pyth publish time, unix seconds. */
  publishTime: number;
  /** Convenience: price * 10^expo as a JS number (lossy; for logging/UI). */
  priceFloat: number;
}

export interface LatestPriceUpdate {
  /** Parsed price metadata for the requested feed. */
  parsed: ParsedPrice;
  /**
   * Base64-encoded update blobs to feed to the receiver
   * (`addPostPriceUpdates`). Pass straight through to `postPriceUpdate`.
   */
  updateData: string[];
}

/** Construct a Hermes client for `hermesUrl` (optional API access token). */
export function makeHermesClient(
  hermesUrl: string,
  accessToken?: string,
): HermesClient {
  return new HermesClient(hermesUrl, accessToken ? { accessToken } : {});
}

/**
 * Fetch the latest price update for a single feed from Hermes. Returns both the
 * base64 update blobs (for posting on-chain) and the parsed price (for
 * staleness/confidence decisions and logging).
 *
 * Throws if Hermes returns no parsed entry for the feed.
 */
export async function fetchLatestPriceUpdate(
  hermes: HermesClient,
  feedId: string,
): Promise<LatestPriceUpdate> {
  const id = normalizeFeedId(feedId);
  const resp = await hermes.getLatestPriceUpdates([id], {
    encoding: "base64",
    parsed: true,
  });

  const updateData = resp.binary.data;
  const entry = resp.parsed?.find(
    (p) => normalizeFeedId(p.id) === id,
  );
  if (!entry) {
    throw new Error(`Hermes returned no parsed price for feed ${id}`);
  }

  const price = BigInt(entry.price.price);
  const expo = entry.price.expo;
  const parsed: ParsedPrice = {
    feedId: normalizeFeedId(entry.id),
    price,
    conf: BigInt(entry.price.conf),
    expo,
    publishTime: entry.price.publish_time,
    priceFloat: Number(price) * 10 ** expo,
  };

  return { parsed, updateData };
}

/**
 * Fetch the PREVIOUS trading session's closing price for a feed from Hermes.
 *
 * PRD §247/§292 require the morning strike ladder to be anchored on the prior
 * day's CLOSE. `getLatestPriceUpdates` returns whatever the feed last published,
 * which at ~08:00 ET is a stale/pre-market tick, not a defined session close.
 *
 * Data-source choice: we query Hermes' timestamped/benchmark endpoint
 * (`getPriceUpdatesAtTimestamp`) as-of the prior trading session's 16:00 ET
 * close instant (computed by `previousCloseUnix` in tradingCalendar.ts, which
 * skips weekends + NYSE holidays). Hermes serves the benchmark update at-or-just
 * -before that timestamp, i.e. the regular-session settle/close print. This is a
 * defensible, deterministic "previous close" without a dedicated EOD feed.
 *
 * Returns the same shape as `fetchLatestPriceUpdate` (parsed price + the
 * base64 update blobs), so callers can reuse it interchangeably.
 *
 * Throws if Hermes returns no parsed entry for the feed at the timestamp; the
 * caller (createStrikes) decides whether to fall back to the latest price.
 */
export async function fetchPreviousClose(
  hermes: HermesClient,
  feedId: string,
  closeUnix: number,
): Promise<LatestPriceUpdate> {
  const id = normalizeFeedId(feedId);
  const resp = await hermes.getPriceUpdatesAtTimestamp(closeUnix, [id], {
    encoding: "base64",
    parsed: true,
  });

  const updateData = resp.binary.data;
  const entry = resp.parsed?.find((p) => normalizeFeedId(p.id) === id);
  if (!entry) {
    throw new Error(
      `Hermes returned no parsed previous-close price for feed ${id} at ${closeUnix}`,
    );
  }

  const price = BigInt(entry.price.price);
  const expo = entry.price.expo;
  const parsed: ParsedPrice = {
    feedId: normalizeFeedId(entry.id),
    price,
    conf: BigInt(entry.price.conf),
    expo,
    publishTime: entry.price.publish_time,
    priceFloat: Number(price) * 10 ** expo,
  };

  return { parsed, updateData };
}

export interface PostPriceUpdateResult {
  /** The `PriceUpdateV2` account `settle_market` should reference. */
  priceUpdateAccount: PublicKey;
  /** Transaction signatures that landed the post. */
  signatures: string[];
}

export interface PostPriceUpdateOptions {
  /**
   * Keep the posted price-update account after the transaction (default true).
   * The settle job needs the account to live until `settle_market` reads it, so
   * we keep it and reclaim rent separately. Set false to auto-close.
   */
  keepAccount?: boolean;
  computeUnitPriceMicroLamports?: number;
}

/**
 * Post a Hermes price update to `connection`'s cluster via the Pyth receiver,
 * creating a `PriceUpdateV2` account. Returns the account pubkey for
 * `settle_market` plus the landed signatures.
 *
 * `payer` signs + funds. `receiverProgramId` should be the cluster's canonical
 * receiver (devnet/mainnet: `rec5EKMGg6MxZYaMdyBfgwp4d5rB9T1VQH5pJv5LtFJ`,
 * already in on-chain `Config.pyth_receiver`).
 */
export async function postPriceUpdate(
  connection: Connection,
  payer: Keypair,
  update: LatestPriceUpdate,
  receiverProgramId: PublicKey,
  options: PostPriceUpdateOptions = {},
): Promise<PostPriceUpdateResult> {
  const { keepAccount = true, computeUnitPriceMicroLamports = 50_000 } = options;

  const wallet = new Wallet(payer);
  const provider = new AnchorProvider(connection, wallet, {
    commitment: "confirmed",
  });

  const receiver = new PythSolanaReceiver({
    connection,
    wallet,
    receiverProgramId,
  });

  const builder = receiver.newTransactionBuilder({
    closeUpdateAccounts: !keepAccount,
  });
  await builder.addPostPriceUpdates(update.updateData);

  const priceUpdateAccount = builder.getPriceUpdateAccount(
    normalizeFeedId(update.parsed.feedId),
  );

  const txs = await builder.buildVersionedTransactions({
    computeUnitPriceMicroLamports,
    tightComputeBudget: true,
  });
  const signatures = await provider.sendAll(txs);

  return { priceUpdateAccount, signatures };
}

/**
 * One-shot convenience used by U2/U5: fetch the latest update for `feedId` and
 * post it. Returns the parsed price and the posted account so the caller can
 * decide whether to `settle_market` or fall back to admin-override.
 */
export async function fetchAndPostLatest(
  connection: Connection,
  payer: Keypair,
  hermes: HermesClient,
  feedId: string,
  receiverProgramId: PublicKey,
  options?: PostPriceUpdateOptions,
): Promise<PostPriceUpdateResult & { parsed: ParsedPrice }> {
  const update = await fetchLatestPriceUpdate(hermes, feedId);
  const posted = await postPriceUpdate(
    connection,
    payer,
    update,
    receiverProgramId,
    options,
  );
  return { ...posted, parsed: update.parsed };
}
