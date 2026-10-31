import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { appAccess } from '../../gce/tools/app-access.mjs';

const pem = generateKeyPairSync('rsa', {modulusLength:2048}).privateKey.export({type:'pkcs1',format:'pem'});

test('operator checks every repo grant, including siblings, and never prints tokens or key material', async () => {
  const calls=[], output=[], errors=[];
  const fetchImpl=async (url, init) => {
    const path=new URL(url).pathname;
    calls.push([init.method,path,init.body && JSON.parse(init.body)]);
    if (path==='/repos/SSFSKIM/excluded/installation') return new Response('{}',{status:404});
    if (path.endsWith('/installation')) {
      const owner=path.split('/')[2];
      return new Response(JSON.stringify({id:owner==='SSFSKIM'?1:2,account:{login:owner}}));
    }
    return new Response(JSON.stringify({token:'secret-token',expires_at:new Date(Date.now()+3600_000).toISOString()}));
  };
  const code=await appAccess(['SSFSKIM/MAWS','SSFSKIM/excluded','neworg/MAWS'], {
    loadApp:async()=>({appId:'1',pem,fetchImpl}),log:s=>output.push(s),error:s=>errors.push(s),
  });
  assert.equal(code,1);
  assert.deepEqual(output,['SSFSKIM/MAWS: account SSFSKIM, installation 1, access OK','neworg/MAWS: account neworg, installation 2, access OK']);
  assert.match(errors[0],/SSFSKIM\/excluded.*selected/);
  assert.deepEqual(calls.filter(c=>c[0]==='POST'),[
    ['POST','/app/installations/1/access_tokens',{repositories:['MAWS']}],
    ['POST','/app/installations/2/access_tokens',{repositories:['MAWS']}],
  ]);
  assert.ok(![...output,...errors].join('\n').includes('secret-token'));
  assert.ok(![...output,...errors].join('\n').includes('PRIVATE KEY'));
});

test('bad usage is refused before reading credentials; success returns zero', async () => {
  for (const args of [[],['bad'],['owner/repo/extra']]) {
    await assert.rejects(appAccess(args,{loadApp:async()=>assert.fail('must not read secrets')}),/usage/);
  }
  assert.equal(await appAccess(['owner/repo'],{loadApp:async()=>({appId:'1',pem,fetchImpl:async url=>new Response(JSON.stringify(
    url.endsWith('/installation')?{id:1,account:{login:'owner'}}:{token:'secret',expires_at:new Date(Date.now()+3600_000).toISOString()}
  ))}),log:()=>{}}),0);
});
