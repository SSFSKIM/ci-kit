// Contents-only access for both the orchestrator's reads and the builders' clones.
import { createAppTokens } from '../../lib/github-app.mjs';
import { createGitHub } from '../../lib/github.mjs';
import { bakeScope } from './manifest.mjs';

export function createBakeAccess(app, repos, githubOptions) {
  const grants = Object.entries(bakeScope(repos));
  const groups = new Map(grants.map(([owner, grant]) => [owner, createAppTokens({ ...app, ...grant })]));
  return {
    gh: createGitHub(async repo => {
      const token = groups.get(repo.split('/')[0].toLowerCase());
      if (!token) throw new Error(`${repo}: owner is not in the bake`);
      return token();
    }, githubOptions),
    // Existing GCE metadata and EC2 user-data transports carry a string. Keep the single-owner wire format;
    // multiple owners carry a JSON map, decoded only by the builder host, never handed to repository code.
    async builderToken() {
      // Each provider starts with a full hour, even if the previous provider's build took most of one.
      const tokens = Object.fromEntries(await Promise.all(grants.map(async ([owner, grant]) =>
        [owner, await createAppTokens({ ...app, ...grant })()])));
      return groups.size === 1 ? Object.values(tokens)[0] : JSON.stringify(tokens);
    },
  };
}
