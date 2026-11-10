import { useSyncExternalStore } from 'react';

export type Theme = 'dark' | 'light';
const KEY = 'bv-theme';

/** First visit: follow the system (dark when it has no preference); afterwards the saved choice. */
function initial(): Theme {
  const saved = localStorage.getItem(KEY);
  if (saved === 'dark' || saved === 'light') return saved;
  return matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
}
let current: Theme = initial();
const listeners = new Set<() => void>();
const apply = (t: Theme) => {
  document.documentElement.classList.toggle('dark', t === 'dark');
  document.documentElement.style.colorScheme = t;
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', t === 'dark' ? '#000000' : '#fafafa');
};
apply(current);

export function setTheme(t: Theme) {
  current = t;
  localStorage.setItem(KEY, t);
  apply(t);
  listeners.forEach((l) => l());
}
export function useTheme(): [Theme, (t: Theme) => void] {
  const theme = useSyncExternalStore((cb) => { listeners.add(cb); return () => { listeners.delete(cb); }; }, () => current);
  return [theme, setTheme];
}
