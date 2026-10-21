// The webhook receiver ci-kit-webhook (spec 2026-10-21 M4, The webhook): the GCE pool's one public endpoint. The
// GitHub App ci-kit-runners delivers its workflow_job events here. A delivery whose X-Hub-Signature-256 does not verify
// against the webhook secret is answered 401 before anything in it is read. A pool job queued in a served repo
// publishes one tick request to Pub/Sub, whose push subscription asks the launcher for a tick; every other delivery
// is answered and dropped. The receiver holds no state, reads no GitHub and launches nothing: a delivery lost here
// costs at most the minute until the launcher's scheduled tick.
import { createHmac, timingSafeEqual } from 'node:crypto';
import { jobCpus } from '../launcher/logic.mjs';

// A workflow_job payload is a few kB; GitHub caps any payload at 25 MB. A body past this is refused unread.
export const MAX_BODY = 1024 * 1024;
const PUBLISH_TIMEOUT_MS = 5_000; // GitHub gives a delivery 10 s

// True when header is `sha256=<hex HMAC-SHA256 of body under secret>`. An empty secret verifies nothing.
export function signatureValid(secret, body, header) {
  if (!secret || typeof header !== 'string' || !header.startsWith('sha256=')) return false;
  const expected = Buffer.from(`sha256=${createHmac('sha256', secret).update(body).digest('hex')}`);
  const given = Buffer.from(header);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

// What a verified delivery asks for: {request: {repo, job, run, labels}} for a queued job that a GCE launch could
// serve (launcher logic's jobCpus: ci-kit-pool, one cpus-N the placements name, no foreign label) in a served repo,
// else {ignored: reason}. served: Set of lowercased owner/name; machines: the first placement's size → machine.
export function tickRequest({ event, payload, served, machines }) {
  if (event === 'ping') return { ignored: 'ping' };
  if (event !== 'workflow_job') return { ignored: `event ${event}` };
  if (payload?.action !== 'queued') return { ignored: `action ${payload?.action}` };
  const repo = payload.repository?.full_name;
  if (typeof repo !== 'string' || !served.has(repo.toLowerCase())) return { ignored: `${repo} is not served` };
  const job = payload.workflow_job ?? {};
  if (!Array.isArray(job.labels) || jobCpus(job.labels, machines) === null) return { ignored: `labels ${JSON.stringify(job.labels)} are not a pool job's` };
  return { request: { repo, job: job.id, run: job.run_id, labels: job.labels } };
}

class TooLarge extends Error {}
async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY) throw new TooLarge();
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

// secret() → the webhook secret (read for each delivery, so a rotation needs no deploy); publish(message) → resolves
// once Pub/Sub took it; log(severity, message, fields).
export function createReceiver({ secret, publish, served, machines, log }) {
  const answer = (res, status, body) => res.writeHead(status, { 'content-type': 'application/json' }).end(`${JSON.stringify(body)}\n`);
  return async function receive(req, res) {
    if (req.method !== 'POST') return answer(res, 405, { error: 'POST only' });
    const delivery = req.headers['x-github-delivery'] ?? null;
    let body;
    try {
      body = await readBody(req);
    } catch (err) {
      if (!(err instanceof TooLarge)) return res.destroy(); // the client went away mid-body: nobody to answer
      res.setHeader('connection', 'close');
      return answer(res, 413, { error: 'body too large' });
    }
    let key;
    try {
      key = (await secret()).trim();
    } catch (err) {
      log('ERROR', `webhook secret unreadable: ${err.message}`, { delivery });
      return answer(res, 500, { error: 'secret unreadable' });
    }
    if (!signatureValid(key, body, req.headers['x-hub-signature-256'])) {
      log('WARNING', 'delivery refused: its signature does not verify', { delivery });
      return answer(res, 401, { error: 'bad signature' });
    }
    let payload;
    try {
      payload = JSON.parse(body.toString('utf8'));
    } catch {
      return answer(res, 400, { error: 'body is not JSON' });
    }
    const { request, ignored } = tickRequest({ event: req.headers['x-github-event'], payload, served, machines });
    if (!request) return answer(res, 200, { ignored });
    try {
      await publish({ ...request, delivery });
    } catch (err) {
      log('ERROR', `tick request not published: ${err.message}`, { delivery, ...request });
      return answer(res, 502, { error: 'tick request not published' });
    }
    log('INFO', `tick requested: ${request.repo} job ${request.job}`, { delivery, ...request });
    return answer(res, 202, { requested: true });
  };
}

// publish(message) for one Pub/Sub topic (projects/<p>/topics/<t>), as the token's account (the receiver's own, which
// may publish to that topic and do nothing else). The message is JSON, base64 as Pub/Sub carries it.
export function createPublisher({ topic, token, fetchImpl = fetch }) {
  return async function publish(message) {
    const res = await fetchImpl(`https://pubsub.googleapis.com/v1/${topic}:publish`, {
      method: 'POST',
      headers: { authorization: `Bearer ${await token()}`, 'content-type': 'application/json' },
      body: JSON.stringify({ messages: [{ data: Buffer.from(JSON.stringify(message)).toString('base64') }] }),
      signal: AbortSignal.timeout(PUBLISH_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`pubsub publish to ${topic}: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
  };
}
