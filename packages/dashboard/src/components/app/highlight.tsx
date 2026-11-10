import { createContext, useContext } from 'react';
import { splitMatches } from '@/lib/history';

/** The search text of the history: matches are highlighted wherever a <Hl> or <HlText> is rendered below the provider. */
export const HighlightContext = createContext('');

export function Hl({ children }: { children: string }) {
  const query = useContext(HighlightContext);
  const parts = splitMatches(children, query);
  if (parts.length === 1 && !parts[0].match) return <>{children}</>;
  return <>{parts.map((p, i) => (p.match ? <mark key={i} className="rounded-sm bg-yellow-300 px-0.5 text-black dark:bg-yellow-500/70">{p.text}</mark> : <span key={i}>{p.text}</span>))}</>;
}
export const useQuery = () => useContext(HighlightContext);
