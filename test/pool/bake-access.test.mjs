import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { createBakeAccess } from '../../pool/bake/github.mjs';

const pem = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type:'pkcs1', format:'pem' });

test('bake reads and builder credentials use each owner installation and only its contents scope', async () => {
  const minted = [], reads = [];
  const fetchImpl = async (url, init) => {
    const path = new URL(url).pathname;
    let body;
    if (path === '/repos/SSFSKIM/MAWS/installation') body = { id:1, account:{login:'SSFSKIM'} };
    else if (path === '/repos/neworg/MAWS/installation') body = { id:2, account:{login:'neworg'} };
    else if (/\/access_tokens$/.test(path)) {
      minted.push([path, JSON.parse(init.body)]);
      body = {token:path.includes('/1/')?'personal':'org',expires_at:new Date(Date.now()+3600_000).toISOString()};
    } else { reads.push([path, init.headers.authorization]); body = {}; }
    return new Response(JSON.stringify(body));
  };
  const access = createBakeAccess({ appId:'1', pem, fetchImpl }, [{repo:'SSFSKIM/MAWS'}, {repo:'neworg/MAWS'}, {repo:'SSFSKIM/ci-kit-sandbox'}], {fetchImpl});
  await access.gh.getRepo('neworg/MAWS');
  await access.gh.getRepo('SSFSKIM/ci-kit-sandbox');
  assert.deepEqual(reads, [['/repos/neworg/MAWS','Bearer org'],['/repos/SSFSKIM/ci-kit-sandbox','Bearer personal']]);
  assert.deepEqual(JSON.parse(await access.builderToken()), {ssfskim:'personal',neworg:'org'});
  assert.deepEqual(minted, [
    ['/app/installations/2/access_tokens',{repositories:['MAWS'],permissions:{contents:'read'}}],
    ['/app/installations/1/access_tokens',{repositories:['MAWS','ci-kit-sandbox'],permissions:{contents:'read'}}],
    ['/app/installations/1/access_tokens',{repositories:['MAWS','ci-kit-sandbox'],permissions:{contents:'read'}}],
    ['/app/installations/2/access_tokens',{repositories:['MAWS'],permissions:{contents:'read'}}],
  ]);
  await access.builderToken();
  assert.equal(minted.length, 6, 'each provider gets newly minted tokens, not a token aged by the previous build');
  await assert.rejects(access.gh.getRepo('stranger/repo'), /not.*bake/i);
  const single = createBakeAccess({appId:'1',pem,fetchImpl},[{repo:'SSFSKIM/MAWS'}]);
  assert.equal(await single.builderToken(), 'personal', 'one-owner transport remains a plain token');
});
