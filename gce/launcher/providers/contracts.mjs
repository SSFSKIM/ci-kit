// Shared provider boundary. These shapes do not select a cloud or change admission.
/**
 * @typedef {'gce'|'ec2'} ProviderName
 * @typedef {'any'|'gce'|'ec2'} RequiredProvider
 * @typedef {{source: string, at: string, initializationUsd?: number}} Price
 * @typedef {object} Candidate
 * @property {ProviderName} provider
 * @property {string} account
 * @property {string} region
 * @property {string} zone
 * @property {string} [zoneId]
 * @property {number} size Logical cpus-N, independent of physical vCPUs.
 * @property {string[]} labels GitHub runner labels, not cloud resource tags.
 * @property {string} machine
 * @property {string} [family] Provider's quota family; not inferred by the cross-provider scheduler.
 * @property {number} vcpus
 * @property {number} memoryGiB
 * @property {'x86_64'} arch
 * @property {'spot'|'standard'} provisioning
 * @property {string} subnet
 * @property {{type: string, sizeGB: number}} disk
 * @property {Price} price
 *
 * @typedef {object} Instance
 * @property {ProviderName} provider
 * @property {string} id Cloud instance id, not the runner name.
 * @property {string} alloc
 * @property {string} runner
 * @property {number} size
 * @property {string[]} labels
 * @property {'pending'|'running'|'stopping'|'stopped'|'gone'} state
 * @property {string} [stateReason]
 * @property {Candidate} candidate
 * @property {string} createdAt
 *
 * @typedef {{outcome: 'accepted'|'capacity'|'quota'|'denied'|'throttled'|'uncertain', scope?: string, detail: string, id?: string}} LaunchResult
 * @typedef {LaunchResult|{outcome: 'abandoned', detail: string}} ReconcileResult
 * @typedef {{kind: 'telemetry'|'claimed', [field: string]: unknown}} TelemetryReport
 * @typedef {{kind: 'terminal', [field: string]: unknown}} TerminalReport
 * @typedef {{telemetry: TelemetryReport[], terminal?: TerminalReport}} AllocationReports
 * @typedef {{v: 1, since: string, billed_usd: number, through: string, read_at: string}} BillingReading
 * @typedef {{zone: string, client_token: string, sent_at: string}} Ec2Attempt
 *
 * @typedef {object} Provider
 * @property {ProviderName} name
 * @property {(config: object, size: number) => Candidate[]} candidates Ordered for one logical size.
 * @property {() => Promise<{instances: Instance[], complete: boolean, room?: object}>} observe
 * @property {() => Promise<{id: string, manifest: object}|null>} readyImage
 * @property {(alloc: object, candidate: Candidate, jit: string, report?: object) => Promise<LaunchResult>} launch
 * @property {(alloc: object) => Promise<ReconcileResult>} reconcileLaunch Observation only; no secret request persistence or replay.
 * @property {(instance: Instance) => Promise<void>} terminate
 * @property {(allocs: object[]) => Promise<Map<string, AllocationReports>>} readReports Only terminal evidence authorizes report-driven claim/retirement.
 * @property {(inventory: object, ledger: object) => Promise<string[]>} cleanupOrphans
 */

export const providerRunnerName = (provider, alloc) => `ci-kit-${provider}-${alloc}`;
export const providerRunnerLabels = (provider, size) => ['self-hosted', 'ci-kit-pool', `cpus-${size}`, `ci-kit-${provider}`];

// null is conflicting demand, never a generic job. Admission consumes this distinction in M4.
export function requiredProvider(labels) {
  const lower = labels.map((label) => label.toLowerCase());
  const gce = lower.includes('ci-kit-gce');
  const ec2 = lower.includes('ci-kit-ec2');
  return gce && ec2 ? null : gce ? 'gce' : ec2 ? 'ec2' : 'any';
}

// In-memory keys need no migration. JSON tuples avoid delimiter collisions between accounts and scopes.
export const providerKey = ({ provider = 'gce', account = null }, ...scope) => JSON.stringify([provider, account, ...scope]);
export const candidateKey = (p) => providerKey(p, p.region ?? p.placement?.region, p.zone, p.machine, p.provisioning);
