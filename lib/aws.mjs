// Runtime AWS access is Google web identity only. Operator credentials belong to setup, never this module.
import { STSClient, AssumeRoleWithWebIdentityCommand } from '@aws-sdk/client-sts';
import { EC2Client } from '@aws-sdk/client-ec2';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { ServiceQuotasClient } from '@aws-sdk/client-service-quotas';
import { CostExplorerClient } from '@aws-sdk/client-cost-explorer';
import { SSMClient } from '@aws-sdk/client-ssm';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

const REGION = 'us-east-2';
const SESSION_SECONDS = 14400;
const REPORT_SECONDS = 9000;
const TIMEOUT_MS = 30_000; // Smithy also needs throwOnRequestTimeout: true; otherwise this only warns.
const roleProviders = new Map();

function accountOf(roleArn) {
  const account = /^arn:aws:iam::(\d{12}):role\/[\w+=,.@/-]+$/.exec(roleArn ?? '')?.[1];
  if (!account) throw new Error('aws: a valid role ARN is required');
  return account;
}
function checkRegion(region) {
  if (region !== REGION) throw new Error('aws: EC2 is restricted to us-east-2');
}

export async function googleIdToken(audience, { fetchImpl = fetch } = {}) {
  const url = new URL('http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/identity');
  url.searchParams.set('audience', audience);
  url.searchParams.set('format', 'full');
  const response = await fetchImpl(url, {
    headers: { 'Metadata-Flavor': 'Google' }, signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`aws: Google identity metadata HTTP ${response.status}`);
  const token = (await response.text()).trim();
  if (!token) throw new Error('aws: Google metadata returned no ID token');
  return token;
}

// One provider owns one role's cache; failures clear only the in-flight request. The caller never receives a
// session too short for report URLs. Injection is at the external token/STS boundary for proofs and tests.
export function createCredentialProvider(roleArn, {
  region = REGION, tokenProvider = googleIdToken, sts, now = Date.now, log = console.log,
} = {}) {
  const audience = `https://ci-kit/${accountOf(roleArn)}/ec2`;
  checkRegion(region);
  // This operation is unsigned. Supplying an explicit rejecting provider also makes accidental signed STS use
  // fail closed, rather than resolving AWS_PROFILE, environment keys or an instance profile.
  sts ??= new STSClient({ region, endpoint: `https://sts.${region}.amazonaws.com`, maxAttempts: 1,
    credentials: async () => { throw new Error('aws: signed STS operations are not supported'); },
    requestHandler: { requestTimeout: TIMEOUT_MS, connectionTimeout: 5000, throwOnRequestTimeout: true } });
  let cached, pending;
  const provider = async () => {
    if (cached && cached.expiration.getTime() - now() >= REPORT_SECONDS * 1000) return cached;
    if (!pending) pending = (async () => {
      const token = await tokenProvider(audience);
      if (typeof token !== 'string' || !token.trim()) throw new Error('aws: no Google ID token');
      const { Credentials: c } = await sts.send(new AssumeRoleWithWebIdentityCommand({
        RoleArn: roleArn, RoleSessionName: 'ci-kit', DurationSeconds: SESSION_SECONDS, WebIdentityToken: token,
      }));
      const expiration = new Date(c?.Expiration);
      if (!c?.AccessKeyId || !c.SecretAccessKey || !c.SessionToken ||
          !Number.isFinite(expiration.getTime()) || expiration.getTime() - now() < REPORT_SECONDS * 1000) {
        throw new Error('aws: STS returned an incomplete or too-short session');
      }
      cached = { accessKeyId: c.AccessKeyId, secretAccessKey: c.SecretAccessKey, sessionToken: c.SessionToken, expiration };
      log(`aws: assumed ${roleArn} until ${expiration.toISOString()}`);
      return cached;
    })().finally(() => { pending = undefined; });
    return pending;
  };
  // The SDK otherwise wraps supplied providers in its own five-minute refresh cache. This SDK-recognized
  // marker preserves our stricter refresh window (characterized against real SDK clients in aws.test.mjs).
  return Object.assign(provider, { memoized: true });
}

function sharedProvider(roleArn, options) {
  accountOf(roleArn);
  if (!roleProviders.has(roleArn)) roleProviders.set(roleArn, createCredentialProvider(roleArn, options));
  return roleProviders.get(roleArn);
}
export function awsCredentials(roleArn) {
  return sharedProvider(roleArn)();
}

export function createAws({ roleArn, region = REGION, tokenProvider, log, sts, now = Date.now } = {}) {
  checkRegion(region);
  const options = { region, tokenProvider, log, sts, now };
  // Explicit proof/test providers must not contaminate the process's metadata-backed role caches.
  const credentials = tokenProvider || sts ? createCredentialProvider(roleArn, options) : sharedProvider(roleArn, options);
  const config = { region, credentials, requestHandler: { requestTimeout: TIMEOUT_MS, connectionTimeout: 5000, throwOnRequestTimeout: true } };
  const s3 = new S3Client(config);
  return {
    credentials,
    ec2: new EC2Client({ ...config, maxAttempts: 1 }), // never replay an ambiguous RunInstances
    s3,
    quotas: new ServiceQuotasClient(config),
    ssm: new SSMClient(config),
    ce: new CostExplorerClient({ ...config, region: 'us-east-1', endpoint: 'https://ce.us-east-1.amazonaws.com' }),
    async presignPut({ bucket, key, expiresIn = REPORT_SECONDS }) {
      const fresh = await credentials();
      if (!Number.isInteger(expiresIn) || expiresIn <= 0 || expiresIn > REPORT_SECONDS ||
          fresh.expiration.getTime() - now() < expiresIn * 1000) {
        throw new Error('aws: report URL lifetime exceeds the supported credential lifetime');
      }
      // Pin this signature to the session whose lifetime we checked above, and omit an SDK-generated checksum:
      // the guest chooses the body after signing.
      const signer = new S3Client({ ...config, credentials: fresh, requestChecksumCalculation: 'WHEN_REQUIRED' });
      try {
        return await getSignedUrl(signer, new PutObjectCommand({ Bucket: bucket, Key: key }), { expiresIn });
      } finally { signer.destroy(); }
    },
  };
}
