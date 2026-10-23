// Configured instances exist even when disabled: eligibility is scheduler policy, management is not.
import { createAws } from '../../../lib/aws.mjs';
import { createProvider as gceProvider } from './gce.mjs';
import { createProvider as ec2Provider } from './ec2.mjs';

export function createProviders({ gce, cfg, config, ec2, now, log, limits, awsFactory = createAws }) {
  return [gceProvider({ gce, cfg, config, now, log, limits }), ...(ec2?.accounts ?? []).map((account) => ec2Provider({
    aws: awsFactory({ roleArn: account.roles.launcher, region: account.region, log }), account, cfg, now, log,
  }))];
}
