// The launcher's HTTP surface (spec 2026-10-21 M4) over serve(trigger) (ticker.mjs): which path asks for which tick,
// and what each caller is answered. Cloud Run has checked every caller against the service's invokers before this.
const MAX_REQUEST_BODY = 64 * 1024; // a Pub/Sub push envelope of one tick request is under 1 kB

// say(severity, message, fields): the structured log line.
export function createHandler({ serve, say }) {
  return async function handle(req, res) {
    const path = new URL(req.url, 'http://launcher').pathname;
    if (req.method !== 'POST') return json(res, 405, { error: 'POST only' });
    if (path === '/request') {
      const asked = await requestOf(req).catch(() => null);
      say('INFO', `tick request${asked?.repo ? `: ${asked.repo} job ${asked.job}` : ''}`, { request: asked });
      serve('requested').catch(() => {}); // a failed tick is logged by tick(); the minute tick reconciles
      return json(res, 202, { requested: true });
    }
    if (path !== '/tick') return json(res, 404, { error: `no ${path}` });
    try {
      return json(res, 200, await serve('scheduled'));
    } catch (err) {
      return json(res, 500, { error: err.message });
    }
  };
}

// The push envelope's message, for the log: which job asked. An unreadable one is still a request (Cloud Run has
// already checked the caller).
async function requestOf(req) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_REQUEST_BODY) return null;
    chunks.push(chunk);
  }
  try {
    const { message } = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    return { ...JSON.parse(Buffer.from(message.data, 'base64').toString('utf8')), published: message.publishTime };
  } catch {
    return null;
  }
}

const json = (res, status, body) => res.writeHead(status, { 'content-type': 'application/json' }).end(`${JSON.stringify(body)}\n`);
