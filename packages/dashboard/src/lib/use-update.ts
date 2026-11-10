import { useCallback, useEffect, useState } from 'react';
import { api, ApiError, type UpdateStatus } from '@/api';

/**
 * Fetches the update state. Polls every 2 s while an update is running or the server is unreachable (it goes away and
 * comes back during an update), every minute otherwise.
 */
export function useUpdate(enabled = true) {
  const [st, setSt] = useState<UpdateStatus | null>(null);
  const [offline, setOffline] = useState(false);
  const load = useCallback(async () => {
    try { setSt(await api<UpdateStatus>('GET', '/api/update')); setOffline(false); } catch (e) {
      if (!(e instanceof ApiError) || e.status >= 500) setOffline(true);
    }
  }, []);
  const running = st?.progress?.state === 'running';
  useEffect(() => {
    if (!enabled) return;
    void load();
    const t = setInterval(load, running || offline ? 2000 : 60_000);
    return () => clearInterval(t);
  }, [enabled, load, running, offline]);
  return { st, offline, reload: load };
}
