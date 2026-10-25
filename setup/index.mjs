import { appendFile } from 'node:fs/promises';
import { applySetup, reportError } from './apply.mjs';

try {
  const install = process.env.INPUT_INSTALL || 'false';
  if (!['true', 'false'].includes(install)) throw new Error('install input: expected true or false');
  const result = await applySetup({ root: process.env.INPUT_ROOT || undefined, install: install === 'true' });
  if (process.env.GITHUB_OUTPUT) {
    await appendFile(process.env.GITHUB_OUTPUT, `hash=${result.hash}\ninstalled=${result.installed}\nstale=${result.stale}\n`);
  }
} catch (e) { reportError(e); }
