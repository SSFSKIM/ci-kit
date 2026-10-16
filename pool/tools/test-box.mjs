#!/usr/bin/env node
// A pool box by hand, for the backstop tests (spec A7) and debugging (docs/pool.md): a server labelled like a pool
// box (ci-kit=pool, ci-kit-state=booting), from the newest pool snapshot or a stock image, with optional user-data.
//   node pool/tools/test-box.mjs <name> [--type cx23] [--location hel1] [--stock] [--user-data <file>]
// Prints the server id. The Hetzner token comes from the HCLOUD_TOKEN environment variable.
import { readFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { createHcloud } from '../../lib/hcloud.mjs';
import { newestImage, poolFirewall } from '../lib/ensure.mjs';

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: { type: { type: 'string', default: 'cx23' }, location: { type: 'string', default: 'hel1' }, stock: { type: 'boolean', default: false }, 'user-data': { type: 'string' } },
});
const name = positionals[0];
if (!name?.startsWith('ci-kit-')) {
  console.error('usage: test-box.mjs <name starting ci-kit-> [--type cx23] [--location hel1] [--stock] [--user-data <file>]');
  process.exit(2);
}
const hc = createHcloud(process.env.HCLOUD_TOKEN?.trim());
const image = values.stock ? 'ubuntu-24.04' : newestImage(await hc.images('ci-kit=pool-image'))?.id;
if (!image) throw new Error('no pool snapshot');
const { server } = await hc.createServer({
  name,
  server_type: values.type,
  location: values.location,
  image,
  firewalls: [{ firewall: (await poolFirewall(hc)).id }],
  labels: { 'ci-kit': 'pool', 'ci-kit-state': 'booting' },
  ...(values['user-data'] ? { user_data: await readFile(values['user-data'], 'utf8') } : {}),
});
console.log(JSON.stringify({ id: server.id, name: server.name, created: server.created, image }));
