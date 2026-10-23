// Only short-lived installation tokens reach a VM; the existing bake's App secrets stay on the orchestrator.
import { execFileSync } from 'node:child_process';
import { createAppTokens } from '../../lib/github-app.mjs';
import { WARM_SCOPE } from '../../pool/bake/warm.mjs';
const secret = (name) => execFileSync('gcloud', ['secrets', 'versions', 'access', 'latest', '--secret', name, '--project', 'ssfskim-ci-kit'], {encoding:'utf8'});
export async function token(scope = WARM_SCOPE) {
  return createAppTokens({appId:secret('ci-kit-app-id').trim(), pem:secret('ci-kit-app-key'), owner:'SSFSKIM', scope})();
}
if (process.argv[2] === 'warm') process.stdout.write(await token());
