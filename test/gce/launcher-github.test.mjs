import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createLauncherGitHub } from '../../gce/launcher/github.mjs';

const pem = generateKeyPairSync('rsa', {modulusLength:2048}).privateKey.export({type:'pkcs1',format:'pem'});
const cfg = JSON.parse(readFileSync(new URL('../../pool/config/gce.json', import.meta.url),'utf8'));
const sha = 'a'.repeat(40);

test('cold config reads use the ledger installation when the public kit has no installation, retaining conditional polling', async () => {
  const calls=[], logs=[];
  const current = {...cfg,repos:[{repo:'neworg/MAWS',allow_public:true}]};
  const fetchImpl=async (url,init) => {
    const u=new URL(url), path=u.pathname;
    calls.push({path,auth:init.headers.authorization,etag:init.headers['if-none-match']});
    if (path==='/repos/SSFSKIM/ci-kit/installation') return new Response('{}',{status:404});
    if (path==='/repos/SSFSKIM/ci-kit-sandbox/installation') return new Response(JSON.stringify({id:1,account:{login:'SSFSKIM'}}));
    if (path==='/repos/neworg/MAWS/installation') return new Response(JSON.stringify({id:2,account:{login:'neworg'}}));
    if (path.endsWith('/access_tokens')) return new Response(JSON.stringify({token:path.includes('/1/')?'personal-token':'org-token',expires_at:new Date(Date.now()+3600_000).toISOString()}));
    if (path==='/repos/SSFSKIM/ci-kit/commits') {
      assert.equal(init.headers.authorization,'Bearer personal-token');
      const file=u.searchParams.get('path');
      const etag=`"${file}"`;
      if (init.headers['if-none-match']===etag) return new Response(null,{status:304});
      return new Response(JSON.stringify(file.endsWith('gce.json')?[{sha}]:[]),{headers:{etag}});
    }
    if (path==='/repos/neworg/MAWS') {
      assert.equal(init.headers.authorization,'Bearer org-token');
      return new Response('{}');
    }
    throw Error(`unexpected ${path}`);
  };
  const clients=createLauncherGitHub({app:{appId:'1',pem,fetchImpl},ledgerRepo:'SSFSKIM/ci-kit-sandbox',githubOptions:{fetchImpl},
    fetchText:async url=>{assert.equal(url,`https://raw.githubusercontent.com/SSFSKIM/ci-kit/${sha}/pool/config/gce.json`);return JSON.stringify(current);},
    readBundled:async name=>name==='gce.json'?JSON.stringify(cfg):null,bundledCommit:'bundled',log:line=>logs.push(line),
  });
  const first=await clients.source();
  assert.equal(first.config,sha,'cold start must use live main, not its deployed bundle');
  assert.deepEqual(first.cfg.repos,current.repos);
  assert.equal(first.ec2,null);
  await clients.source();
  assert.equal(calls.filter(c=>c.path==='/repos/SSFSKIM/ci-kit/installation').length,0);
  assert.equal(calls.filter(c=>c.etag).length,2,'both metadata polls reuse their ETags');
  assert.ok(!logs.some(line=>line.includes('bundled')));
  await clients.gh.getRepo('neworg/MAWS');
});
