// Test helpers for the history collector: a zip writer, a vitest 5 report builder shaped like a real one, and a fake
// GitHub that answers the client's requests from a scripted repo.
import { crc32, deflateRawSync } from 'node:zlib';

// A zip archive of { name: text } entries, deflated, as upload-artifact's zips are.
export function zipOf(files) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const [name, text] of Object.entries(files)) {
    const data = Buffer.from(text);
    const packed = deflateRawSync(data);
    const fname = Buffer.from(name);
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(8, 8);
    local.writeUInt16LE(0x21, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(packed.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(fname.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(8, 10);
    central.writeUInt16LE(0x21, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(packed.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(fname.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, fname, packed);
    centrals.push(central, fname);
    offset += local.length + fname.length + packed.length;
  }
  const dir = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Object.keys(files).length, 8);
  end.writeUInt16LE(Object.keys(files).length, 10);
  end.writeUInt32LE(dir.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, dir, end]);
}

const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');

// A report as vitest 5's junit reporter writes it with classnameTemplate '{displayName}:{filename}': one <testsuite>
// per (project, file), named by the file's path from the root config (`suite`, when a project has its own root),
// stamped at report time, its time counting hooks.
// suites: [{ project, file, suite?, time, cases: [{ name, time?, status?: 'failed'|'skipped', message? }] }]
export function vitestReport({ timestamp, suites }) {
  const all = suites.flatMap((s) => s.cases);
  const failures = all.filter((c) => c.status === 'failed').length;
  const total = suites.reduce((t, s) => t + s.time, 0);
  const out = [`<?xml version="1.0" encoding="UTF-8" ?>`, `<testsuites name="vitest tests" tests="${all.length}" failures="${failures}" errors="0" time="${total}">`];
  for (const s of suites) {
    const f = s.cases.filter((c) => c.status === 'failed').length;
    const k = s.cases.filter((c) => c.status === 'skipped').length;
    out.push(`    <testsuite name="${esc(s.suite ?? s.file)}" timestamp="${timestamp}" hostname="runner-1" tests="${s.cases.length}" failures="${f}" errors="0" skipped="${k}" time="${s.time}">`);
    for (const c of s.cases) {
      out.push(`        <testcase classname="${esc(`${s.project}:${s.file}`)}" name="${esc(c.name)}" time="${c.time ?? 0.001}">`);
      if (c.status === 'failed') {
        out.push(`            <failure message="${esc(c.message ?? 'failed')}" type="AssertionError">`);
        out.push(esc(`AssertionError: ${c.message ?? 'failed'}\n ❯ ${s.file}:5:13`));
        out.push('            </failure>');
      }
      if (c.status === 'skipped') out.push('            <skipped/>');
      out.push('        </testcase>');
    }
    out.push('    </testsuite>');
  }
  out.push('</testsuites>', '');
  return out.join('\n');
}

const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

// A fake GitHub for one repo, answering the REST paths lib/github.mjs requests. `repo` holds:
//   runs: [{ id, event, head_branch, head_sha, path, run_attempt, created_at }]
//   jobs: { '<run>/<attempt>': [job] }
//   commits: { sha: { tree, parents: [sha], message } }
//   ancestors: { sha: [ancestor shas] } (what the compare API reports `ahead`)
//   changed: { '<base>...<head>': [{ filename, previous_filename? }] }
//   gone: [sha] (commits GitHub no longer has: a compare naming one is a 404)
//   artifacts: [{ id, name, run, created_at, expired?, zip }]
//   failing: [artifact id] (artifacts whose download fails with a 502)
// `requests` records every path asked for.
export function fakeGitHub(repo) {
  const requests = [];
  const pageOf = (items, url) => {
    const per = Number(url.searchParams.get('per_page') ?? 30);
    const page = Number(url.searchParams.get('page') ?? 1);
    return items.slice((page - 1) * per, page * per);
  };
  const artifactJson = (a) => ({ id: a.id, name: a.name, created_at: a.created_at, expired: a.expired ?? false, workflow_run: { id: a.run } });
  const fetchImpl = async (href) => {
    const url = new URL(href);
    const path = url.pathname.replace(/^\/repos\/[^/]+\/[^/]+/, '');
    requests.push(`${path}${url.search}`);
    let m;
    if (path === '/actions/artifacts') {
      const sorted = [...repo.artifacts].sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
      return json({ total_count: sorted.length, artifacts: pageOf(sorted, url).map(artifactJson) });
    }
    if ((m = /^\/actions\/artifacts\/(\d+)\/zip$/.exec(path))) {
      const a = repo.artifacts.find((x) => x.id === Number(m[1]));
      if (a && (repo.failing ?? []).includes(a.id)) return json({ message: 'Bad Gateway' }, 502);
      return a ? new Response(a.zip, { status: 200 }) : json({ message: 'Not Found' }, 404);
    }
    if (path === '/actions/runs') {
      const since = url.searchParams.get('created').replace(/^>=/, '');
      const runs = repo.runs.filter((r) => r.created_at >= since).sort((a, b) => b.id - a.id);
      return json({ total_count: runs.length, workflow_runs: pageOf(runs, url) });
    }
    if ((m = /^\/actions\/runs\/(\d+)$/.exec(path))) {
      const run = repo.runs.find((r) => r.id === Number(m[1]));
      return run ? json(run) : json({ message: 'Not Found' }, 404);
    }
    if ((m = /^\/actions\/runs\/(\d+)\/attempts\/(\d+)\/jobs$/.exec(path))) {
      const jobs = repo.jobs[`${m[1]}/${m[2]}`] ?? [];
      return json({ total_count: jobs.length, jobs: pageOf(jobs, url) });
    }
    if ((m = /^\/actions\/runs\/(\d+)\/artifacts$/.exec(path))) {
      const mine = repo.artifacts.filter((a) => a.run === Number(m[1])).map(artifactJson);
      return json({ total_count: mine.length, artifacts: pageOf(mine, url) });
    }
    if ((m = /^\/git\/commits\/([0-9a-f]+)$/.exec(path))) {
      const c = repo.commits[m[1]];
      return c ? json({ sha: m[1], tree: { sha: c.tree }, parents: c.parents.map((sha) => ({ sha })), message: c.message ?? '' }) : json({ message: 'Not Found' }, 404);
    }
    if ((m = /^\/compare\/([0-9a-f]+)\.\.\.([0-9a-f]+)$/.exec(path))) {
      const [, base, head] = m;
      if ((repo.gone ?? []).includes(base) || (repo.gone ?? []).includes(head)) return json({ message: 'Not Found' }, 404);
      const ahead = (repo.ancestors?.[head] ?? []).includes(base);
      return json({ status: ahead ? 'ahead' : 'diverged', files: ahead ? (repo.changed?.[`${base}...${head}`] ?? []) : [] });
    }
    return json({ message: `fake: no route for ${path}` }, 404);
  };
  return { fetchImpl, requests };
}
