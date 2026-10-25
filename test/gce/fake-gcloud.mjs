// A fake gcloud for gce/deploy.sh's network and alert parts: the calls those parts make, answered from a JSON state file
// ($FAKE_GCLOUD_STATE) that their create and update calls change, each call appended to $FAKE_GCLOUD_LOG as a JSON array
// of its arguments (without the global --project and --quiet). A call it does not know exits 3, so a test sees any
// call the script starts to make.
// state: {network: bool, subnets: [{name, region, range, pga}], routers: [region], nats: [region], firewall: [line],
//   metrics: [{name, description, filter}], channel: name or null, policies: [the policy files' JSON],
//   services: {<Cloud Run service>: {revisions: n, latestReady: name, traffic: [{revisionName, percent, latestRevision}],
//   stuck?: true (update-traffic succeeds and changes nothing), trafficFails?: true (update-traffic exits 1)}}; the webhook part's secret, topic and subscription calls succeed}
import { readFileSync, writeFileSync, appendFileSync } from 'node:fs';

const args = process.argv.slice(2).filter((a) => !a.startsWith('--project=') && a !== '--quiet');
appendFileSync(process.env.FAKE_GCLOUD_LOG, `${JSON.stringify(args)}\n`);
const state = JSON.parse(readFileSync(process.env.FAKE_GCLOUD_STATE, 'utf8'));
// Applies a create or update to the state and saves it: exit 0.
function change(apply) {
  apply();
  writeFileSync(process.env.FAKE_GCLOUD_STATE, JSON.stringify(state));
  return 0;
}
const flag = (name) => args.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const has = (name) => args.includes(`--${name}`);
const words = args.filter((a) => !a.startsWith('--'));
const call = words.slice(0, 4).join(' ');
const subnet = () => state.subnets.find((s) => s.name === words[4] && s.region === flag('region'));

function answer() {
  if (call.startsWith('compute networks describe')) return state.network ? 0 : 1;
  if (call.startsWith('compute networks create')) return change(() => { state.network = true; });
  if (call === 'compute networks subnets describe') {
    if (!subnet()) return 1;
    if (flag('format')?.includes('privateIpGoogleAccess')) console.log(subnet().pga ? 'True' : 'False');
    return 0;
  }
  if (call === 'compute networks subnets list') {
    const named = flag('format')?.includes('name');
    for (const s of state.subnets) console.log(named ? `${s.name}\t${s.range}` : s.range);
    return 0;
  }
  if (call === 'compute networks subnets create') {
    return change(() => state.subnets.push({ name: words[4], region: flag('region'), range: flag('range'), pga: has('enable-private-ip-google-access') }));
  }
  if (call === 'compute networks subnets update' && subnet() && has('enable-private-ip-google-access')) return change(() => { subnet().pga = true; });
  if (call === 'compute routers describe ci-kit-router') return state.routers.includes(flag('region')) ? 0 : 1;
  if (call === 'compute routers create ci-kit-router') return change(() => state.routers.push(flag('region')));
  if (call === 'compute routers nats describe') return state.nats.includes(flag('region')) ? 0 : 1;
  if (call === 'compute routers nats create') {
    if (!state.routers.includes(flag('region'))) {
      console.error('fake gcloud: no router there');
      return 1;
    }
    return change(() => state.nats.push(flag('region')));
  }
  if (call === 'compute routers nats update') return state.nats.includes(flag('region')) ? 0 : 1;
  if (call.startsWith('compute firewall-rules list')) {
    for (const line of state.firewall) console.log(line);
    return 0;
  }
  if (call.startsWith('logging metrics describe')) return state.metrics.some((m) => m.name === words[3]) ? 0 : 1;
  if (call.startsWith('logging metrics create')) {
    return change(() => state.metrics.push({ name: words[3], description: flag('description'), filter: flag('log-filter') }));
  }
  if (call === 'beta monitoring channels list') {
    if (state.channel) console.log(state.channel);
    return 0;
  }
  if (call === 'beta monitoring channels create') {
    change(() => { state.channel = 'projects/p/notificationChannels/1'; });
    console.log(state.channel);
    return 0;
  }
  if (call === 'alpha monitoring policies list') {
    const title = /^displayName="(.*)"$/.exec(flag('filter'))?.[1];
    if (state.policies.some((p) => p.displayName === title)) console.log(`projects/p/alertPolicies/${title.length}`);
    return 0;
  }
  if (call === 'alpha monitoring policies create') {
    return change(() => state.policies.push(JSON.parse(readFileSync(flag('policy-from-file'), 'utf8'))));
  }
  // Cloud Run as it behaves: a deploy adds a revision, and traffic that follows the latest moves to it; traffic pinned
  // to a revision by name (after `update-traffic --to-revisions=<old>=100`) stays there.
  const service = () => state.services?.[words[3]];
  const verb = words.slice(0, 3).join(' ');
  if (words[0] === 'run' && words[1] === 'deploy') {
    return change(() => {
      state.services ??= {};
      const svc = (state.services[words[2]] ??= { revisions: 0, latestReady: null, traffic: [{ percent: 100, latestRevision: true }] });
      svc.revisions += 1;
      svc.latestReady = `${words[2]}-${String(svc.revisions).padStart(5, '0')}-new`;
      for (const t of svc.traffic) if (t.latestRevision) t.revisionName = svc.latestReady;
    });
  }
  if (verb === 'run services update-traffic' && service()) {
    if (!has('to-latest')) return 3;
    if (service().trafficFails) {
      console.error('ERROR: (gcloud.run.services.update-traffic) failed');
      return 1;
    }
    if (service().stuck) return 0;
    return change(() => { service().traffic = [{ revisionName: service().latestReady, percent: 100, latestRevision: true }]; });
  }
  if (verb === 'run services describe') {
    if (!service()) return 1;
    if (flag('format') === 'json') console.log(JSON.stringify({ status: { url: `https://${words[3]}.run.app`, latestReadyRevisionName: service().latestReady, traffic: service().traffic } }));
    else console.log(`https://${words[3]}.run.app`);
    return 0;
  }
  if (verb === 'run services add-iam-policy-binding') return 0;
  if (verb === 'run jobs deploy') return change(() => { (state.jobs ??= {})[words[3]] = args; });
  if (verb === 'run jobs add-iam-policy-binding') return state.jobs?.[words[3]] ? 0 : 1;
  if (verb === 'scheduler jobs describe') return state.schedules?.[words[3]] ? 0 : 1;
  if (verb === 'scheduler jobs create' || verb === 'scheduler jobs update') {
    return change(() => { (state.schedules ??= {})[words[4]] = args; });
  }
  if (call.startsWith('secrets describe')) return 0;
  if (call.startsWith('secrets get-iam-policy')) {
    console.log('serviceAccount:ci-kit-webhook@ssfskim-ci-kit.iam.gserviceaccount.com');
    return 0;
  }
  if (words[0] === 'pubsub') return 0;
  console.error(`fake gcloud: unexpected call ${JSON.stringify(args)}`);
  return 3;
}

process.exit(answer());
