import type { PreviewHealth } from '@bivouac/shared';

/** Does the owner need to know about the preview? Healthy, starting, stopped and unknown are not alarms. */
export const previewIsBroken = (p: PreviewHealth | null | undefined): p is PreviewHealth => !!p && (p.state === 'unhealthy' || p.state === 'down');

/** Seconds until the next automatic restart; null when none is planned. */
export function retryInSeconds(p: PreviewHealth, now = Date.now()): number | null {
  if (!p.nextRetryAt) return null;
  return Math.max(0, Math.ceil((Date.parse(p.nextRetryAt) - now) / 1000));
}
/** "restarted 3 times, last cause …" for a healthy preview that had to be restarted. */
export function restartNote(p: PreviewHealth | null | undefined): string | null {
  if (!p || p.state !== 'healthy' || p.restarts < 1) return null;
  return `restarted ${p.restarts} ${p.restarts === 1 ? 'time' : 'times'}${p.cause ? `, last cause: ${p.cause}` : ''}`;
}

// ---------- share links
export interface ShareLike { createdAt: number; expiresAt: number | null; revoked: boolean; active: boolean }
/** Why a link no longer works, for the read-only list. */
export function shareEnd(s: ShareLike): string {
  if (s.revoked) return 'Revoked';
  if (s.expiresAt) return `Expired ${new Date(s.expiresAt * 1000).toLocaleString()}`;
  return 'Inactive';
}
