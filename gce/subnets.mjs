#!/usr/bin/env node
// The subnetworks of the VPC ci-kit, for gce/deploy.sh network (spec 2026-10-21, Placements): one per placement of
// pool/config/gce.json, so a new placement needs no edit to the script. A subnetwork that exists is left as it is; a
// new one takes the first free /20 of 10.64.0.0/16 (4,091 addresses, far over a region's 64-instance quota) that overlaps
// no range already in the network.
//   node gce/subnets.mjs list              the config's subnetworks, one "<name> <region>" a line
//   node gce/subnets.mjs free [<cidr>...]  the first free /20 given the ranges already in the network
import { readFileSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseGceConfig } from './launcher/config.mjs';

const POOL_RANGE = '10.64.0.0/16';
const PREFIX = 20;

export function subnetsOf(cfg) {
  const seen = new Map();
  for (const { subnetwork, region } of cfg.placements) if (!seen.has(subnetwork)) seen.set(subnetwork, { name: subnetwork, region });
  return [...seen.values()];
}

const toInt = (ip) => ip.split('.').reduce((n, o) => n * 256 + Number(o), 0);
const toIp = (n) => [24, 16, 8, 0].map((s) => Math.floor(n / 2 ** s) % 256).join('.');
function span(cidr) {
  const [ip, bits] = cidr.split('/');
  const start = toInt(ip);
  return [start, start + 2 ** (32 - Number(bits)) - 1];
}

// The first /20 of the pool's range that overlaps none of `taken` (CIDRs), or null.
export function freeRange(taken) {
  const used = taken.map(span);
  const [from, to] = span(POOL_RANGE);
  const size = 2 ** (32 - PREFIX);
  for (let start = from; start + size - 1 <= to; start += size) {
    if (!used.some(([a, b]) => start <= b && a <= start + size - 1)) return `${toIp(start)}/${PREFIX}`;
  }
  return null;
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  const [command, ...args] = process.argv.slice(2);
  if (command === 'list') {
    const cfg = parseGceConfig(readFileSync(new URL('../pool/config/gce.json', import.meta.url), 'utf8'));
    for (const { name, region } of subnetsOf(cfg)) console.log(`${name} ${region}`);
  } else if (command === 'free') {
    const range = freeRange(args);
    if (!range) {
      console.error(`subnets: no free /${PREFIX} left in ${POOL_RANGE}`);
      process.exit(1);
    }
    console.log(range);
  } else {
    console.error('usage: subnets.mjs list | free [<cidr>...]');
    process.exit(2);
  }
}
