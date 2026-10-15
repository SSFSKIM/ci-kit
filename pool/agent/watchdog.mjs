#!/usr/bin/env node
// The watchdog (spec §3 Watchdog): a systemd timer, separate from the agent, every 5 minutes. It deletes this box
// through the Hetzner API after 30 min without a successful reconciliation (the agent's last-success file; from
// boot until the first) or after 24 h up. Deletion depends only on the Hetzner token and that file.
// The ledger row is written first when GitHub can be reached (the App's credentials); it is best effort, because
// the box this fires on is usually one that cannot reach GitHub. The guard finalizes the row.
import { readFile, stat } from 'node:fs/promises';
import { createHcloud, serverLocation, serverPriceHourly } from '../../lib/hcloud.mjs';
import { createGitHub } from '../../lib/github.mjs';
import { createAppTokens } from '../../lib/github-app.mjs';
import { parsePoolConfig } from '../lib/config.mjs';
import { createLedgerStore } from '../lib/ledger-store.mjs';
import { makeRow } from '../lib/ledger.mjs';
import { watchdogVerdict } from './logic.mjs';

const ETC = process.env.CI_KIT_ETC ?? '/etc/ci-kit';
const LAST_SUCCESS = '/var/lib/ci-kit/last-success';

async function main() {
  const serverId = Number((await (await fetch('http://169.254.169.254/hetzner/v1/metadata/instance-id', { signal: AbortSignal.timeout(20_000) })).text()).trim());
  const hc = createHcloud((await readFile(`${ETC}/hcloud_token`, 'utf8')).trim());
  const server = await hc.server(serverId);
  const lastSuccess = await stat(LAST_SUCCESS).then((s) => s.mtimeMs, () => null);
  const btime = Number(/^btime (\d+)$/m.exec(await readFile('/proc/stat', 'utf8'))[1]) * 1000;
  const verdict = watchdogVerdict({ server, lastSuccess, bootTime: btime, now: Date.now() });
  if (!verdict) {
    console.log(`watchdog: ok (last success ${lastSuccess ? new Date(lastSuccess).toISOString() : 'none yet'}, up since ${server.created})`);
    return;
  }
  console.log(`watchdog: deleting server ${serverId} (${verdict})`);
  try {
    const cfg = parsePoolConfig(await readFile(`${ETC}/pool.json`, 'utf8'));
    const tokens = createAppTokens({ appId: (await readFile(`${ETC}/app_id`, 'utf8')).trim(), pem: await readFile(`${ETC}/app.pem`, 'utf8'), owner: 'SSFSKIM' });
    const row = makeRow(
      { id: serverId, created: server.created, type: server.server_type.name, location: serverLocation(server), price: serverPriceHourly(server), jobs: Number(server.labels['ci-kit-jobs'] ?? 0) },
      { deleted: Date.now(), end: verdict, state: 'deleting' },
    );
    await createLedgerStore(createGitHub(tokens), cfg.ledger).upsertRow(row);
  } catch (err) {
    console.log(`watchdog: ledger row not written (${err.message}); deleting anyway`);
  }
  await hc.deleteServer(serverId);
}

main().catch((err) => {
  console.error(`watchdog: ${err.stack ?? err.message}`);
  process.exit(1);
});
