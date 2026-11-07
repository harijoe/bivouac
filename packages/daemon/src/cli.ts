// `bivouac` command line, run inside the web container (see /usr/local/bin/bivouac). Needs shell access to the server.
import path from 'node:path';
import { Auth } from './auth.js';
import { baseUrl, loadConfig } from './config.js';
import { Store } from './db.js';

const cfg = loadConfig();
const store = new Store(path.join(cfg.dataDir, 'bivouac.db'), cfg.secretKey);
cfg.domain = store.getSetting('domain') ?? cfg.domain;
const auth = new Auth(store);
const [cmd, ...rest] = process.argv.slice(2);

function setupLink() {
  const code = auth.createSetupCode();
  return `${baseUrl(cfg)}/setup?code=${code}`;
}

switch (cmd) {
  case 'setup-link':
  case 'reset-admin':
    console.log(setupLink());
    break;
  case 'session': {
    // For automated tests only: a session without GitHub. Works only from the server shell.
    if (rest[0] !== 'create') { console.error('usage: bivouac session create --github-id <id>'); process.exit(2); }
    const i = rest.indexOf('--github-id');
    const id = Number(rest[i + 1]);
    if (i < 0 || !Number.isInteger(id) || id <= 0) { console.error('usage: bivouac session create --github-id <id>'); process.exit(2); }
    const user = auth.getUser(id) ?? auth.upsertUser({ githubId: id, login: `test-${id}` }, 'admin');
    if (!auth.isAllowedById(user.githubId)) auth.addAllowed('user', String(id), user.login);
    auth.audit('cli', 'test_session_created', { githubId: id });
    console.log(auth.createSession(id, 'test'));
    break;
  }
  case 'status':
    console.log(`admin=${auth.hasAdmin() ? 'yes' : 'no'}\ndomain=${cfg.domain}\nsetup_open=${auth.setupOpen() ? 'yes' : 'no'}`);
    break;
  case 'domain':
    console.log(cfg.domain);
    break;
  default:
    console.error('usage: bivouac <setup-link | reset-admin | status | session create --github-id <id> | domain>');
    process.exit(cmd ? 2 : 0);
}
