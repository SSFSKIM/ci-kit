// Setup reads GitHub's current identity contract, never infers it from repository age or mutates its settings.
// https://docs.github.com/actions/reference/openid-connect-reference
export const GUARD_REPO = 'SSFSKIM/ci-kit';
const name = value => typeof value === 'string' && /^[A-Za-z0-9_.-]+$/.test(value);
const id = value => Number.isSafeInteger(value) && value > 0;

export function validateGuardSubject(subject) {
  if (typeof subject !== 'string' || !/^repo:(?:[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+|[A-Za-z0-9_.-]+@[1-9]\d*\/[A-Za-z0-9_.-]+@[1-9]\d*):ref:refs\/heads\/main$/.test(subject)) {
    throw new Error('setup: a resolved exact GitHub main subject is required');
  }
  return subject;
}

export function githubMainSubject(repository, customization) {
  const owner = repository?.owner;
  if (!name(owner?.login) || !name(repository?.name) || !id(owner?.id) || !id(repository?.id)
      || repository.full_name !== `${owner.login}/${repository.name}`) throw new Error('setup: incomplete GitHub repository identity');
  if (customization?.use_default !== true || typeof customization.use_immutable_subject !== 'boolean'
      || (customization.include_claim_keys !== undefined && JSON.stringify(customization.include_claim_keys) !== '["repo","context"]')) {
    throw new Error('setup: unsupported GitHub OIDC subject template; default repo/context claims are required');
  }
  const prefix = customization.use_immutable_subject
    ? `repo:${owner.login}@${owner.id}/${repository.name}@${repository.id}`
    : `repo:${owner.login}/${repository.name}`;
  if (customization.sub_claim_prefix !== undefined && customization.sub_claim_prefix !== prefix) {
    throw new Error('setup: GitHub OIDC subject prefix does not match repository identity');
  }
  return validateGuardSubject(`${prefix}:ref:refs/heads/main`);
}

export async function readGuardSubject(gh) {
  const [repository, customization] = await Promise.all([
    gh(`repos/${GUARD_REPO}`), gh(`repos/${GUARD_REPO}/actions/oidc/customization/sub`),
  ]);
  return githubMainSubject(repository, customization);
}
