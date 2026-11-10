import { describe, expect, it } from 'vitest';
import { filterRepos, type Repo } from './repo-filter';

const r = (fullName: string): Repo => ({ fullName, private: false, added: false, pushedAt: null, owner: fullName.split('/')[0] });
const repos = [r('acme/web'), r('acme/api'), r('julien/web-site'), r('julien/dotfiles')];
describe('filterRepos', () => {
  it('returns everything for an empty query', () => expect(filterRepos(repos, '  ')).toEqual(repos));
  it('matches the name and keeps the order', () => expect(filterRepos(repos, 'web').map((x) => x.fullName)).toEqual(['acme/web', 'julien/web-site']));
  it('matches owner and name together', () => expect(filterRepos(repos, 'julien web').map((x) => x.fullName)).toEqual(['julien/web-site']));
  it('accepts owner/name', () => expect(filterRepos(repos, 'acme/a').map((x) => x.fullName)).toEqual(['acme/api']));
  it('is case-insensitive', () => expect(filterRepos(repos, 'ACME')).toHaveLength(2));
});
