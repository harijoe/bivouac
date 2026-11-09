import { getDomain } from 'tldts';

export interface DnsRecord { type: 'A'; name: string; value: string }
export interface DnsPlan { zone: string; records: DnsRecord[] }

/**
 * The records to create at the registrar for an instance on `domain`. Registrars expect names relative to the zone of
 * the registrable domain (public suffix list, so `.co.uk` counts as one suffix): the root is `@`, a subdomain keeps
 * only what sits before the zone. `bivouac.cloud` -> `@` and `*`; `dev.deslope.com` -> `dev` and `*.dev`.
 */
export function dnsPlan(domain: string, ip: string): DnsPlan {
  const host = domain.trim().toLowerCase().replace(/\.$/, '');
  const zone = getDomain(host) ?? host.split('.').slice(-2).join('.');
  const sub = host === zone ? '' : host.slice(0, host.length - zone.length - 1);
  return { zone, records: [{ type: 'A', name: sub || '@', value: ip }, { type: 'A', name: sub ? `*.${sub}` : '*', value: ip }] };
}
