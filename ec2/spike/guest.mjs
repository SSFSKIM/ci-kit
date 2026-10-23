// Guest-only measurement helper, invoked by systemd on AWS or the GCE startup script.
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {execFileSync,spawnSync} from 'node:child_process';
import {jobEnvironmentArgs} from '/opt/ci-kit/pool/agent/docker.mjs';
const cloud=process.argv[2];
const emit=(type,data)=>console.log(`SPIKE_JSON ${JSON.stringify({type,cloud,at:Date.now(),...data})}`);
const uptime=()=>Number(readFileSync('/proc/uptime','utf8').split(' ')[0]);
const sh=(cmd,args=[])=>execFileSync(cmd,args,{encoding:'utf8'}).trim();
async function md(path){const h=cloud==='gce'?{'Metadata-Flavor':'Google'}:{'X-aws-ec2-metadata-token':imds}; const r=await fetch(path,{headers:h,signal:AbortSignal.timeout(15000)});if(!r.ok)throw Error(`metadata ${r.status}`);return r.text()}
let imds;
if(cloud==='ec2') imds=await (await fetch('http://169.254.169.254/latest/api/token',{method:'PUT',headers:{'X-aws-ec2-metadata-token-ttl-seconds':'21600'}})).text();
const cfg=JSON.parse(cloud==='ec2'?await md('http://169.254.169.254/latest/user-data'):await md('http://169.254.169.254/computeMetadata/v1/instance/attributes/spike-config'));
emit('guest',{uptime:uptime(),kernel:sh('uname',['-r']),node:process.version,kit:sh('git',['-C','/opt/ci-kit','rev-parse','HEAD']),warm:JSON.parse(readFileSync('/var/lib/ci-kit/cache/warm.json','utf8'))});
if(cloud==='ec2'){
  const started=Date.now();
  process.env.CI_KIT_JIT=cfg.jit;
  sh('docker',['run','-d','--name','spike-runner',...jobEnvironmentArgs(),'ci-kit-runner:latest']);
  delete process.env.CI_KIT_JIT;
  emit('container',{started,uptime:uptime()});
}
// GCE's ordinary job unit already starts its runner. AWS uses precisely the same runner image/environment.
for(let n=0;n<120;n++){
 const result=spawnSync('docker',['logs',cloud==='ec2'?'spike-runner':sh('hostname')],{encoding:'utf8'});
 const logs=(result.stdout||'')+(result.stderr||'');
 if(logs.includes('Listening for Jobs')) {emit('listening',{uptime:uptime()});break;}
 if(n===119)throw Error('runner not listening in 120 seconds');
 await new Promise(r=>setTimeout(r,1000));
}
if(cfg.runs){
 mkdirSync('/var/lib/ci-kit/cache/work/spike',{recursive:true});
 sh('chown',['-R','1001:1001','/var/lib/ci-kit/cache/work/spike']);
 writeFileSync('/var/lib/ci-kit/cache/work/spike/bench.sh',Buffer.from(cfg.bench,'base64'));
 const stat=()=>({cpu:readFileSync('/proc/stat','utf8').split('\n')[0].trim().split(/\s+/).slice(1).map(Number),disk:readFileSync('/proc/diskstats','utf8')});
 for(let n=0;n<cfg.runs;n++){
  sh('sync');writeFileSync('/proc/sys/vm/drop_caches','3');
  const before=stat(),start=Date.now();
  const r=spawnSync('docker',['run','--rm','--entrypoint','/bin/bash',...jobEnvironmentArgs(),'-e','CI_KIT_GH_TOKEN','-e',`MAWS_SHA=${cfg.sha}`,'ci-kit-runner:latest','/var/lib/ci-kit/cache/work/spike/bench.sh'],{encoding:'utf8',env:{...process.env,CI_KIT_GH_TOKEN:cfg.token},timeout:900000,maxBuffer:8<<20});
  const end=Date.now(),after=stat();
  emit('bench',{n,start,end,status:r.status,before,after,stdout:r.stdout,stderr:r.stderr});
  if(r.status!==0)throw Error(`benchmark ${n} failed`);
 }
}
emit('done',{uptime:uptime()});
// Keep alive only until the orchestrator has read the console; the independent systemd deadline bounds it.
