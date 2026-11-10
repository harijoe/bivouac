import { useCallback, useEffect, useRef, useState } from 'react';

/** Live updates (Server-Sent Events). Handlers can change between renders; the connection only depends on `url`. */
export function useStream(url: string | null, handlers: Record<string, (data: any) => void>) {
  const ref = useRef(handlers);
  ref.current = handlers;
  useEffect(() => {
    if (!url) return;
    const es = new EventSource(url);
    for (const name of Object.keys(ref.current)) es.addEventListener(name, (e) => ref.current[name]?.(JSON.parse((e as MessageEvent).data)));
    return () => es.close();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url]);
}

/** Re-renders every second while `active` (elapsed times). */
export function useNow(active: boolean) {
  const [n, setN] = useState(Date.now());
  useEffect(() => { if (!active) return; const t = setInterval(() => setN(Date.now()), 1000); return () => clearInterval(t); }, [active]);
  return n;
}

/**
 * Runs an async action with a busy flag and the error message of its failure. `run` resolves with the result, or
 * `undefined` when it failed (the error is then in `error`).
 */
export function useAsync() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const run = useCallback(async <T,>(fn: () => Promise<T>): Promise<T | undefined> => {
    setBusy(true); setError('');
    try { return await fn(); } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }, []);
  return { busy, error, run, setError };
}

/** Loads data once (and again on `reload()`), with loading and error states. */
export function useLoad<T>(load: () => Promise<T>, deps: unknown[] = []) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [tick, setTick] = useState(0);
  const loadRef = useRef(load);
  loadRef.current = load;
  useEffect(() => {
    let live = true;
    setLoading(true);
    loadRef.current().then((d) => { if (live) { setData(d); setError(''); } }).catch((e) => { if (live) setError((e as Error).message); }).finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tick, ...deps]);
  const reload = useCallback(() => setTick((t) => t + 1), []);
  return { data, error, loading, reload, setData };
}

/** Debounced copy of a value. */
export function useDebounced<T>(value: T, ms = 300) {
  const [v, setV] = useState(value);
  useEffect(() => { const t = setTimeout(() => setV(value), ms); return () => clearTimeout(t); }, [value, ms]);
  return v;
}
