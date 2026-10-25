// Smoke reads the declaration, not the repository's install inputs. Never execute repository code on the host.
import { lstat, mkdir, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { parseConfig } from '../../plan/config.mjs';

async function fileBytes(path) {
  const stat = await lstat(path);
  if (!stat.isDirectory()) return stat.size; // Includes symlink bytes, never follows their targets.
  const sizes = await Promise.all((await readdir(path)).map(name => fileBytes(join(path, name))));
  return sizes.reduce((sum, size) => sum + size, 0);
}

export async function retainSmokeSource(source, { exec }) {
  source = await realpath(source);
  async function input(path) {
    const target = await realpath(resolve(source, path));
    if (!target.startsWith(`${source}${sep}`)) throw new Error(`smoke input ${path} escapes the checkout`);
    return { path, bytes: await readFile(target), mode: (await lstat(target)).mode & 0o777 };
  }
  const config = await input('.github/ci-kit.yml');
  const { setup } = parseConfig(config.bytes.toString('utf8'), { isPrivate: true });
  const files = [config];
  if (setup.script) files.push(await input(setup.script));
  // Preserve the clone's actual local config so smoke still audits it; do not replace it with a sanitized one.
  const gitConfig = await readFile(join(source, '.git/config'));
  const before = await fileBytes(source);
  await rm(source, { recursive: true, force: true });
  await exec('git', ['init', '--quiet', '--template=', source]);
  await writeFile(join(source, '.git/config'), gitConfig);
  for (const { path, bytes, mode } of files) {
    const target = resolve(source, path);
    await mkdir(dirname(target), { recursive: true });
    // Materialize the bytes hashed by setupHash, including an in-tree symlink's target, at the declared path.
    await writeFile(target, bytes, { mode });
  }
  return { before, after: await fileBytes(source) };
}
