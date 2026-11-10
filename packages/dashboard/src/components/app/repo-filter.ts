export interface Repo { fullName: string; private: boolean; added: boolean; pushedAt: string | null; owner: string }

/** Filters by owner and name while typing; every word must appear in `owner/name` (a word with a slash matches the full name). Keeps the API order (recent first). */
export function filterRepos(repos: Repo[], query: string): Repo[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return repos;
  return repos.filter((r) => { const n = r.fullName.toLowerCase(); return words.every((w) => n.includes(w)); });
}
