"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useConnection, useAnchorWallet } from "@solana/wallet-adapter-react";
import type { AnchorWallet } from "@solana/wallet-adapter-react";
import { PublicKey } from "@solana/web3.js";

import {
  fetchBalances,
  fetchBook,
  fetchConfig,
  fetchMarket,
  listMarkets,
  type Balances,
  type BookView,
  type ConfigView,
  type MarketView,
} from "./market";
import { configPda } from "./pdas";
import { getProgram, getReadOnlyProgram, type MeridianProgram } from "./program";

const POLL_MS = 3000;

interface MeridianState {
  /** Wallet-bound program when connected, else a read-only client. */
  program: MeridianProgram;
  wallet: AnchorWallet | undefined;
  walletPubkey: PublicKey | null;
  config: ConfigView | null;
  configError: string | null;
  markets: MarketView[];
  selected: PublicKey | null;
  selectMarket: (m: PublicKey | null) => void;
  market: MarketView | null;
  book: BookView | null;
  balances: Balances | null;
  /** Refetch market list + selected market data now. */
  refresh: () => Promise<void>;
}

const Ctx = createContext<MeridianState | null>(null);

export function useMeridian(): MeridianState {
  const v = useContext(Ctx);
  if (!v) throw new Error("useMeridian must be used within MeridianProvider");
  return v;
}

export function MeridianProvider({ children }: { children: React.ReactNode }) {
  const { connection } = useConnection();
  const wallet = useAnchorWallet();

  const readProgram = useMemo(
    () => getReadOnlyProgram(connection),
    [connection],
  );
  const program = useMemo(
    () => (wallet ? getProgram(connection, wallet) : readProgram),
    [connection, wallet, readProgram],
  );

  const [config, setConfig] = useState<ConfigView | null>(null);
  const [configError, setConfigError] = useState<string | null>(null);
  const [markets, setMarkets] = useState<MarketView[]>([]);
  const [selected, setSelected] = useState<PublicKey | null>(null);
  const [market, setMarket] = useState<MarketView | null>(null);
  const [book, setBook] = useState<BookView | null>(null);
  const [balances, setBalances] = useState<Balances | null>(null);

  const walletPubkey = wallet?.publicKey ?? null;

  // Config + market list load once per program identity.
  const loadConfigAndMarkets = useCallback(async () => {
    try {
      const cfg = await fetchConfig(readProgram, configPda());
      setConfig(cfg);
      setConfigError(null);
    } catch (e) {
      setConfig(null);
      setConfigError(
        "Config not found on this cluster — bootstrap it first " +
          "(see app/README.md).",
      );
    }
    try {
      setMarkets(await listMarkets(readProgram));
    } catch {
      setMarkets([]);
    }
  }, [readProgram]);

  useEffect(() => {
    void loadConfigAndMarkets();
  }, [loadConfigAndMarkets]);

  // Selected-market data (market + book + balances). Stored in a ref so the
  // poll interval always calls the latest closure without re-subscribing.
  const refreshSelected = useCallback(async () => {
    if (!selected || !config) {
      setMarket(null);
      setBook(null);
      setBalances(null);
      return;
    }
    try {
      const [mv, bk] = await Promise.all([
        fetchMarket(program, selected),
        fetchBook(program, selected),
      ]);
      setMarket(mv);
      setBook(bk);
      if (walletPubkey) {
        setBalances(
          await fetchBalances(connection, walletPubkey, config.usdcMint, mv),
        );
      } else {
        setBalances(null);
      }
    } catch {
      // transient RPC hiccup — keep last good data
    }
  }, [program, selected, config, walletPubkey, connection]);

  const refreshRef = useRef(refreshSelected);
  refreshRef.current = refreshSelected;

  useEffect(() => {
    void refreshSelected();
  }, [refreshSelected]);

  useEffect(() => {
    if (!selected) return;
    const id = setInterval(() => void refreshRef.current(), POLL_MS);
    return () => clearInterval(id);
  }, [selected]);

  const refresh = useCallback(async () => {
    await loadConfigAndMarkets();
    await refreshRef.current();
  }, [loadConfigAndMarkets]);

  const value: MeridianState = {
    program,
    wallet,
    walletPubkey,
    config,
    configError,
    markets,
    selected,
    selectMarket: setSelected,
    market,
    book,
    balances,
    refresh,
  };

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
