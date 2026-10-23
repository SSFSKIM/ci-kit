// Throwaway M1 orchestrator. Credentials and raw consoles stay in a mode-0700 directory outside git.
// Commands: build | gce | aws <AMI> <zone> <runs> | image <builder-id> | cleanup
import {execFileSync} from 'node:child_process';
import {readFileSync,writeFileSync,appendFileSync,mkdirSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {token} from './token.mjs';
import {createGitHub} from '../../lib/github.mjs';
import {parseEvents} from './metrics.mjs';
const root=fileURLToPath(new URL('.',import.meta.url));
const state=process.env.SPIKE_STATE || '/private/tmp/ci-kit-m1-state';
mkdirSync(state,{recursive:true,mode:0o700});
const env={...process.env,AWS_PROFILE:'ci-kit-ops',AWS_REGION:'us-east-2',AWS_PAGER:''};
const cli=(bin,args)=>{try{return execFileSync(bin,args,{encoding:'utf8',env,maxBuffer:32<<20,timeout:120000,stdio:['ignore','pipe','pipe']}).trim();}catch(e){throw Error(`${bin}: ${e.stderr || `exit ${e.status}`}`);}};
const aws=(...a)=>{const text=cli('aws',[...a,'--output','json']);return text?JSON.parse(text):null;};
const gc=(...a)=>JSON.parse(cli('gcloud',[...a,'--project','ssfskim-ci-kit','--format=json','--quiet']));
const save=(name,v)=>writeFileSync(`${state}/${name}.json`,JSON.stringify(v,null,2));
const pause=(ms)=>new Promise(r=>setTimeout(r,ms));
function record(name,out){
 if(out)writeFileSync(`${state}/${name}.console`,out);
 for(const v of parseEvents(out))appendFileSync(`${state}/${name}.jsonl`,JSON.stringify(v)+'\n');
}
const tags=[{Key:'ci-kit-pool',Value:'ec2-spike'},{Key:'ci-kit-purpose',Value:'spike'}];
const subnets={'us-east-2a':'subnet-01046dc75127e7e11','us-east-2b':'subnet-0efc861caf2eeb888','us-east-2c':'subnet-0110187a2f23b0d25'};
const gh=createGitHub(await token({repositories:['ci-kit-sandbox'],permissions:{administration:'write'}}));
async function jit(name){const r=await gh.jitConfig('SSFSKIM/ci-kit-sandbox',{name,labels:['self-hosted','ec2-spike']});save(`${name}-runner`,{id:r.runner.id,name});return r.encoded_jit_config;}
async function config(name,runs){
 let bench=readFileSync(`${root}bench.sh`,'utf8');
 if(process.env.SPIKE_PREFETCH==='1')bench=bench.replace('stage install_start','stage prefetch_start\nfind "$npm_config_store_dir" "$RUNNER_TOOL_CACHE" "$COREPACK_HOME" -type f -print0 | xargs -0 -P 8 -r cat > /dev/null\nstage prefetch_end\nstage install_start');
 return {jit:await jit(name),runs,sha:JSON.parse(readFileSync(`${state}/maws-head.json`)).sha,token:runs?await token():undefined,bench:Buffer.from(bench).toString('base64')};
}
function launch(image,zone,userData,build=false){
 const active=aws('ec2','describe-instances','--filters','Name=tag:ci-kit-pool,Values=ec2-spike','Name=instance-state-name,Values=pending,running').Reservations.flatMap(r=>r.Instances);
 if(active.length>=4)throw Error('four-instance concurrency limit');
 const request={ImageId:image,InstanceType:'c8a.2xlarge',MinCount:1,MaxCount:1,SubnetId:subnets[zone],SecurityGroupIds:['sg-04b8b036fd64144d6'],UserData:userData,InstanceMarketOptions:{MarketType:'spot',SpotOptions:{SpotInstanceType:'one-time',InstanceInterruptionBehavior:'terminate'}},InstanceInitiatedShutdownBehavior:build?'stop':'terminate',MetadataOptions:{HttpTokens:'required',HttpPutResponseHopLimit:1},BlockDeviceMappings:[{DeviceName:'/dev/sda1',Ebs:{VolumeSize:50,VolumeType:'gp3',Encrypted:true,DeleteOnTermination:true}}],TagSpecifications:['instance','volume','spot-instances-request'].map(ResourceType=>({ResourceType,Tags:tags}))};
 // One-time spot cannot stop for imaging; the short-lived builder is on-demand, jobs remain spot.
 if(build){delete request.InstanceMarketOptions;request.TagSpecifications=request.TagSpecifications.filter(t=>t.ResourceType!=='spot-instances-request');}
 else if(process.env.SPIKE_INIT_RATE){const rate=Number(process.env.SPIKE_INIT_RATE);if(rate<100||rate>300||!Number.isInteger(rate))throw Error('initialization rate must be 100–300 MiB/s');request.BlockDeviceMappings[0].Ebs.VolumeInitializationRate=rate;}
 const name=`aws-${Date.now()}`;save(`${name}-request`,{...request,UserData:'REDACTED'});
 const start=Date.now();
 const result=aws('ec2','run-instances','--cli-input-json',JSON.stringify(request));
 const i=result.Instances[0];save(`${i.InstanceId}-launch`,{start,accepted:Date.now(),arm:process.env.SPIKE_PREFETCH==='1'?'prefetch':process.env.SPIKE_INIT_RATE?`init-${process.env.SPIKE_INIT_RATE}`:'plain',instance:i});console.log('launched',i.InstanceId,zone);
 return {id:i.InstanceId,start};
}
async function waitAws(vm,build=false){
 let running;
 for(let n=0;n<190;n++){
  let i;
  try{i=aws('ec2','describe-instances','--instance-ids',vm.id).Reservations[0].Instances[0];}
  catch(e){if(e.message.includes('InvalidInstanceID.NotFound')&&Date.now()-vm.start<120000){await pause(2000);continue;}throw e;}
  if(i.State.Name==='running'&&!running){running=Date.now();save(`${vm.id}-running`,{running});}
  let out='';
  try{out=aws('ec2','get-console-output','--instance-id',vm.id,...(i.State.Name==='running'?['--latest']:[])).Output||'';record(vm.id,out);}catch{}
  if(build?out.includes('SPIKE_BUILD_READY'):out.includes('"type":"done"')) {console.log('complete',vm.id);return;}
  if(out.includes('SPIKE_BUILD_EXIT=')&&!out.includes('SPIKE_BUILD_EXIT=0'))throw Error(`builder failed ${vm.id}`);
  if(['terminated','stopped'].includes(i.State.Name))throw Error(`${vm.id} ${i.State.Name} before result`);
  await pause(15000);
 }
 throw Error(`deadline ${vm.id}`);
}
const [command,a,b,c]=process.argv.slice(2);
if(command==='build'){
 const kit='7292a8b1dada5e3726dff164d9662ef6bafc3972';
 const script=readFileSync(`${root}builder.sh`,'utf8').replace('__KIT_SHA__',kit).replace('__WARM_TOKEN__',await token()).replace('__GUEST_B64__',readFileSync(`${root}guest.mjs`).toString('base64'));
 if(Buffer.byteLength(script)>16384)throw Error('user data over 16 KiB');
 const vm=launch('ami-0fc53b217ec1ad816','us-east-2b',script,true);save('builder',vm);await waitAws(vm,true);
 aws('ec2','stop-instances','--instance-ids',vm.id);
 cli('aws',['ec2','wait','instance-stopped','--instance-ids',vm.id]);
}else if(command==='observe'){
 const launch=JSON.parse(readFileSync(`${state}/${a}-launch.json`));
 await waitAws({id:a,start:launch.start});
 save(`${a}-terminated`,{requested:Date.now(),result:aws('ec2','terminate-instances','--instance-ids',a)});
}else if(command==='image'){
 cli('aws',['ec2','wait','instance-stopped','--instance-ids',a]);
 const result=aws('ec2','create-image','--instance-id',a,'--name',`ci-kit-spike-${Date.now()}`,'--tag-specifications',JSON.stringify(['image','snapshot'].map(ResourceType=>({ResourceType,Tags:tags}))));
 save('image',result);console.log(result);
}else if(command==='aws'){
 const name=`ci-kit-spike-${Date.now()}`;const cfg=await config(name,Number(c||0));
 const vm=launch(a,b,JSON.stringify(cfg));await waitAws(vm);
 save(`${vm.id}-terminated`,{requested:Date.now(),result:aws('ec2','terminate-instances','--instance-ids',vm.id)});cli('aws',['ec2','wait','instance-terminated','--instance-ids',vm.id]);await gh.deleteRunner('SSFSKIM/ci-kit-sandbox',JSON.parse(readFileSync(`${state}/${name}-runner.json`)).id).catch(()=>{});
}else if(command==='gce'){
 const name=`ci-kit-spike-${Date.now()}`,zone=a||'us-east5-a',region=zone.slice(0,-2);
 const cfg=await config(name,6);
 const startup=`#!/bin/bash\nset -euo pipefail\nexec > >(tee /dev/console) 2>&1\nsystemd-run --unit=spike-deadline --on-active=40m /sbin/poweroff\nprintf '%s' '${readFileSync(`${root}guest.mjs`).toString('base64')}' | base64 -d > /opt/spike-guest.mjs\n/usr/local/bin/node /opt/spike-guest.mjs gce\n`;
 const metadata={items:[{key:'ci-kit-jit',value:cfg.jit},{key:'enable-guest-attributes',value:'TRUE'},{key:'startup-script',value:startup},{key:'spike-config',value:JSON.stringify(cfg)}]};
 save(`${name}-metadata`,metadata);
 // REST insert preserves structured metadata and avoids credentials on the command line.
 const access=cli('gcloud',['auth','print-access-token']);
 const body={name,machineType:`zones/${zone}/machineTypes/c4d-highcpu-8`,labels:{'ci-kit-purpose':'spike','ci-kit-pool':'ec2-spike'},disks:[{boot:true,autoDelete:true,initializeParams:{sourceImage:'projects/ssfskim-ci-kit/global/images/ci-kit-runner-20261021-224528-8ogy-7292a8b1',diskSizeGb:'50',diskType:`zones/${zone}/diskTypes/hyperdisk-balanced`,labels:{'ci-kit-purpose':'spike','ci-kit-pool':'ec2-spike'}}}],networkInterfaces:[{subnetwork:`regions/${region}/subnetworks/ci-kit-${region}`,nicType:'GVNIC',accessConfigs:[{name:'External NAT',type:'ONE_TO_ONE_NAT'}]}],scheduling:{provisioningModel:'SPOT',instanceTerminationAction:'DELETE',onHostMaintenance:'TERMINATE',automaticRestart:false},metadata};
 const start=Date.now();
 const res=await fetch(`https://compute.googleapis.com/compute/v1/projects/ssfskim-ci-kit/zones/${zone}/instances`,{method:'POST',headers:{Authorization:`Bearer ${access}`,'content-type':'application/json'},body:JSON.stringify(body)});
 const result=await res.json();save(`${name}-launch`,{start,accepted:Date.now(),result});if(!res.ok)throw Error(JSON.stringify(result));console.log('launched',name,zone);
 for(let n=0;n<120;n++){
  const op=gc('compute','operations','describe',result.name,'--zone',zone);
  if(op.error)throw Error(JSON.stringify(op.error));
  if(op.status==='DONE'){save(`${name}-operation`,op);break;}
  if(n===119)throw Error('GCE creation deadline');
  await pause(2000);
 }
 for(let n=0;n<180;n++){
  const out=cli('gcloud',['compute','instances','get-serial-port-output',name,'--zone',zone,'--project','ssfskim-ci-kit']);record(name,out);
  if(out.includes('"type":"done"'))break;
  if(n===179)throw Error('GCE deadline');
  await pause(15000);
 }
 gc('compute','instances','delete',name,'--zone',zone);
 await gh.deleteRunner('SSFSKIM/ci-kit-sandbox',JSON.parse(readFileSync(`${state}/${name}-runner.json`)).id).catch(()=>{});
}else if(command==='cleanup'){
 const instances=aws('ec2','describe-instances','--filters','Name=tag:ci-kit-pool,Values=ec2-spike').Reservations.flatMap(r=>r.Instances).filter(i=>i.State.Name!=='terminated');
 if(instances.length){aws('ec2','terminate-instances','--instance-ids',...instances.map(i=>i.InstanceId));cli('aws',['ec2','wait','instance-terminated','--instance-ids',...instances.map(i=>i.InstanceId)]);}
 for(const i of aws('ec2','describe-images','--owners','self','--filters','Name=tag:ci-kit-pool,Values=ec2-spike').Images)aws('ec2','deregister-image','--image-id',i.ImageId);
 for(const s of aws('ec2','describe-snapshots','--owner-ids','self','--filters','Name=tag:ci-kit-pool,Values=ec2-spike').Snapshots)aws('ec2','delete-snapshot','--snapshot-id',s.SnapshotId);
 for(const v of aws('ec2','describe-volumes','--filters','Name=tag:ci-kit-pool,Values=ec2-spike').Volumes){if(v.State!=='available')throw Error(`volume ${v.VolumeId} still attached`);aws('ec2','delete-volume','--volume-id',v.VolumeId);}
 for(const i of gc('compute','instances','list','--filter','labels.ci-kit-purpose=spike AND labels.ci-kit-pool=ec2-spike'))gc('compute','instances','delete',i.name,'--zone',i.zone.split('/').pop());
 for(const r of await gh.runners('SSFSKIM/ci-kit-sandbox'))if(r.name.startsWith('ci-kit-spike-'))await gh.deleteRunner('SSFSKIM/ci-kit-sandbox',r.id);
}else throw Error('command: build | image <id> | aws <ami> <zone> <runs> | gce | cleanup');
