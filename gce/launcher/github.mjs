// The launcher's GitHub clients and live configuration source share one App token cache.
import { createGitHub } from '../../lib/github.mjs';
import { createAppTokens } from '../../lib/github-app.mjs';
import { createConfigSource } from './source.mjs';

export function createLauncherGitHub({ app, ledgerRepo, githubOptions, ...sourceOptions }) {
  const tokens = createAppTokens(app);
  const gh = createGitHub(tokens, githubOptions);
  // Public ci-kit need not have an App installation. Resolve the config client's token through the bundled
  // ledger repo, which the launcher already needs. Unauthenticated REST's 60/hour budget cannot sustain the
  // two metadata reads per minute; authenticated conditional polling retains the existing rate-limit behavior.
  const configGh = createGitHub(() => tokens(ledgerRepo), githubOptions);
  const source = createConfigSource({ ...sourceOptions, gh: configGh });
  return { gh, source };
}
