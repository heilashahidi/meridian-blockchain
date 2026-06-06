"use client";

import { useCallback, useState } from "react";

import { useMeridian } from "@/hooks/MeridianContext";
import { formatError } from "@/lib/tx";

export interface TxRunner {
  busy: boolean;
  error: string | null;
  status: string | null;
  /** Run a tx-producing fn; on success show its message + refresh context.
   *  Resolves `true` when the tx succeeded, `false` if it threw — lets callers
   *  reset their form only on success. */
  run: (fn: () => Promise<string>) => Promise<boolean>;
  /** Clear the last success/error message (e.g. when the user switches action). */
  reset: () => void;
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
        return true;
      } catch (e) {
        setError(formatError(e));
        return false;
      } finally {
        setBusy(false);
      }
    },
    [refresh],
  );

  const reset = useCallback(() => {
    setError(null);
    setStatus(null);
  }, []);

  return { busy, error, status, run, reset };
}
