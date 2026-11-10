/** How a Claude account's expiry is shown: a label and a tone (colour). */
export type ExpiryTone = 'ok' | 'warn' | 'bad' | 'none';
export interface Expiry { label: string; tone: ExpiryTone }

const DAY = 86400_000;

export function claudeExpiry(a: { kind: 'oauth' | 'apikey'; expiresAt: string | null; expired: boolean }, now = Date.now()): Expiry {
  if (a.expired) return { label: 'Expired', tone: 'bad' };
  if (!a.expiresAt) return { label: a.kind === 'apikey' ? 'No expiry' : 'Valid', tone: a.kind === 'apikey' ? 'none' : 'ok' };
  const days = Math.ceil((Date.parse(a.expiresAt) - now) / DAY);
  if (days <= 0) return { label: 'Expired', tone: 'bad' };
  const left = days > 60 ? `${Math.round(days / 30)} months` : days === 1 ? '1 day' : `${days} days`;
  return { label: `Expires in ${left}`, tone: days < 30 ? 'warn' : 'ok' };
}
