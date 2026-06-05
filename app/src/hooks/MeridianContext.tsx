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
} from "@/lib/market";
import { configPda } from "@/lib/pdas";
import { getProgram, getReadOnlyProgram, type MeridianProgram } from "@/lib/program";

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

  // Latest selection, read inside async fetches to discard results that arrive
  // after the user switched markets (in-flight-request guard).
  const selectedRef = useRef<PublicKey | null>(selected);
  selectedRef.current = selected;

  // Switching markets clears the prior market's data immediately so a stale
  // book/balances never render under the newly-selected market.
  const selectMarket = useCallback((m: PublicKey | null) => {
    setSelected(m);
    setMarket(null);
    setBook(null);
    setBalances(null);
  }, []);

  // Clear balances the instant the connected WALLET changes. Without this, a
  // stale Yes/No reading from the previously-connected wallet survives the
  // switch (refreshSelected keeps last-good data on any RPC hiccup), which can
  // keep e.g. Buy No greyed on a brand-new, position-free wallet. Null balances
  // make the position guard treat the wallet as empty (all actions open) until
  // refreshSelected repopulates for the new wallet — the correct neutral state.
  useEffect(() => {
    setBalances(null);
  }, [walletPubkey]);

  // Selected-market data (market + book + balances). Stored in a ref so the
  // poll interval always calls the latest closure without re-subscribing.
  const refreshSelected = useCallback(async () => {
    const target = selected;
    if (!target || !config) {
      setMarket(null);
      setBook(null);
      setBalances(null);
      return;
    }
    try {
      const [mv, bk] = await Promise.all([
        fetchMarket(program, target),
        fetchBook(program, target),
      ]);
      const bal = walletPubkey
        ? await fetchBalances(connection, walletPubkey, config.usdcMint, mv)
        : null;
      // Discard if the user switched markets while this fetch was in flight.
      if (!selectedRef.current || !selectedRef.current.equals(target)) return;
      setMarket(mv);
      setBook(bk);
      setBalances(bal);
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

  // After a tx, refresh the selected market's data only — config and the market
  // set don't change in response to a trade, so don't re-scan them every time.
  const refresh = useCallback(async () => {
    await refreshRef.current();
  }, []);

  const value: MeridianState = {
    program,
    wallet,
    walletPubkey,
    config,
    configError,
    markets,
    selected,
    selectMarket,
    market,
    book,
    balances,
    refresh,
  };

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
