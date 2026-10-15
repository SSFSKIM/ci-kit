// Build the spike's two snapshots in parallel: "small" (Ubuntu 24.04, Docker, the
// runner image) and "large" (the same plus 10 GB of incompressible data).
// Usage: node make-snapshots.mjs [type] [location]
import { readFileSync } from 'node:fs';
import { hc, waitAction, ensureFirewall, sleep, now, log } from './api.mjs';

const [type = 'cx23', location = 'hel1'] = process.argv.slice(2);
const template = readFileSync(new URL('./builder-userdata.sh', import.meta.url), 'utf8');
const variants = [{ size: 'small', extraGb: 0 }, { size: 'large', extraGb: 10 }];
const fw = await ensureFirewall();

async function build({ size, extraGb }) {
  const t0 = now();
  const { server } = await hc('POST', '/servers', {
    name: `ci-kit-spike-builder-${size}`,
    server_type: type,
    location,
    image: 'ubuntu-24.04',
    labels: { 'ci-kit': 'spike', 'ci-kit-role': 'builder' },
    firewalls: [{ firewall: fw }],
    user_data: template.replace('__EXTRA_GB__', String(extraGb)),
  });
  log(size, 'builder', server.id, 'created');
  try {
    for (;;) {
      const { server: s } = await hc('GET', `/servers/${server.id}`);
      if (s.status === 'off' && now() - t0 > 60) break;
      if (now() - t0 > 1500) throw new Error(`${size} builder never powered off`);
      await sleep(10000);
    }
    log(size, 'builder off after', Math.round(now() - t0), 's');
    const { image, action } = await hc('POST', `/servers/${server.id}/actions/create_image`, {
      type: 'snapshot',
      description: `ci-kit M4 spike ${size}`,
      labels: { 'ci-kit': 'spike', 'ci-kit-size': size },
    });
    await waitAction(action.id);
    const { image: img } = await hc('GET', `/images/${image.id}`);
    log(size, 'snapshot', img.id, 'image_size', img.image_size, 'GB disk_size', img.disk_size);
    return { size, id: img.id, image_size: img.image_size, disk_size: img.disk_size, build_s: Math.round(now() - t0) };
  } finally {
    await hc('DELETE', `/servers/${server.id}`);
    log(size, 'builder', server.id, 'deleted');
  }
}

const results = await Promise.allSettled(variants.map(build));
console.log(JSON.stringify(results.map((r) => r.value ?? String(r.reason))));
