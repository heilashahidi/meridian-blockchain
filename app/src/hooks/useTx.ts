"use client";

import { useCallback, useState } from "react";

import { useMeridian } from "@/hooks/MeridianContext";
import { formatError } from "@/lib/tx";

export interface TxRunner {
  busy: boolean;
  error: string | null;
  status: string | null;
  /** Run a tx-producing fn; on success show its message + refresh context. */
  run: (fn: () => Promise<string>) => Promise<void>;
}

/** Shared submit/status plumbing for the trade panels. */
export function useTx(): TxRunner {
  const { refresh } = useMeridian();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);

  const run = useCallback(
    async (fn: () => Promise<string>) => {
      setBusy(true);
      setError(null);
      setStatus(null);
      try {
        const msg = await fn();
        setStatus(msg);
        await refresh();
      } catch (e) {
        setError(formatError(e));
      } finally {
        setBusy(false);
      }
    },
    [refresh],
  );

  return { busy, error, status, run };
}
