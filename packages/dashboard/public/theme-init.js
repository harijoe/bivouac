// Applies the saved (or system) theme before the first paint, so there is no flash. External file: the CSP forbids inline scripts.
try {
  var t = localStorage.getItem('bv-theme');
  if (t !== 'dark' && t !== 'light') t = matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
  document.documentElement.classList.toggle('dark', t === 'dark');
  document.documentElement.style.colorScheme = t;
} catch (e) { /* storage blocked: keep the default (dark) */ }
