import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkImage } from '../../ec2/vm/job.mjs';

test('host image check accepts repo records beside legacy fields and rejects incomplete applies without leaking repo text',async t=>{
  const root=await mkdtemp(join(tmpdir(),'ci-kit-image-')); t.after(()=>rm(root,{recursive:true,force:true}));
  await mkdir(join(root,'etc/ci-kit'),{recursive:true}); await mkdir(join(root,'etc/cloud'),{recursive:true});
  await writeFile(join(root,'etc/cloud/cloud-init.disabled'),'');
  const manifest={v:1,kit_commit:'a'.repeat(40),node:{22:'v22.1.0',24:'v24.1.0'},runner_version:'2.338.0',
    maws:{revision:'b'.repeat(40),lock_sha256:'c'.repeat(64)},warm:{'maws-files':{ok:true},'pnpm-fetch':{ok:true}},
    repos:{'SSFSKIM/private-name':{revision:'b'.repeat(40),setup_hash:'d'.repeat(16),apply:{ok:true,image_bytes:123},warm:{ok:false}}}};
  const save=()=>writeFile(join(root,'etc/ci-kit/bake-manifest.json'),JSON.stringify(manifest));
  await save(); await checkImage(root);
  manifest.repos['SSFSKIM/private-name'].apply.ok=false; await save();
  await assert.rejects(checkImage(root),error=>{
    assert.equal(error.message,'manifest-incomplete'); assert.doesNotMatch(JSON.stringify(error),/private-name/); return true;
  });
  delete manifest.repos; await save(); await checkImage(root);
  delete manifest.maws; await save(); await assert.rejects(checkImage(root),/manifest-incomplete/);
});
