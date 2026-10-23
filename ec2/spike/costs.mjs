// Planning cost, not an invoice. Public Price List API is global (us-east-1); all products/resources are Ohio.
// node ec2/spike/costs.mjs PRIVATE_STATE CLEANUP_ISO > ec2/spike/evidence/costs.json
import {readFileSync,readdirSync,statSync} from 'node:fs';
import {ec2Cost} from './metrics.mjs';
import {dollars} from '../../gce/launcher/ledger.mjs';
const [dir,cleaned]=process.argv.slice(2),end=Date.parse(cleaned);
const read=(f)=>JSON.parse(readFileSync(`${dir}/${f}`));
const m=JSON.parse(readFileSync(new URL('./evidence/measurements.json',import.meta.url)));
const snapshot=read('snapshot.json').Snapshots[0];
const products=['init','compute','gp3','ipv4'].flatMap(kind=>read(`${kind}-prices.json`).PriceList.map(p=>({kind,...JSON.parse(p)})));
const rates=products.flatMap(p=>Object.values(p.terms.OnDemand).flatMap(t=>Object.values(t.priceDimensions).map(d=>({kind:p.kind,sku:p.product.sku,description:d.description,usd:Number(d.pricePerUnit.USD),unit:d.unit,publicationDate:p.publicationDate}))));
const spot=read('spot-prices.json').SpotPriceHistory;
const spotRate=(zone)=>Number(spot.find(p=>p.AvailabilityZone===zone).SpotPrice);
const base={diskGb:50,gp3Monthly:rates.find(r=>r.kind==='gp3'&&r.unit==='GB-Mo').usd,ipv4Hourly:rates.find(r=>r.kind==='ipv4').usd,snapshotBytes:snapshot.FullSnapshotSizeInBytes};
const initRate=(arm)=>arm==='init-200'?rates.find(r=>r.description.includes('100 MiB/s - 200')).usd:arm==='init-300'?rates.find(r=>r.description.includes('201 MiB/s - 300')).usd:0;
const jobs=m.benches.filter(b=>b.n===0).map(b=>{
 const boot=m.boots.find(x=>x.id===b.id),seconds=boot.apiToListening+b.wall;
 if(b.cloud==='gce'){
  // The existing ledger's 2026-10-21 catalog rates: east5 C4D highcpu-8 = 8 cores + 15 GiB RAM.
  const h=Math.max(60,seconds)/3600;
  return {cloud:'gce',zone:boot.zone,seconds,compute:h*(8*.01362+15*2**30/1e9*.001454),disk:h*(50*.08+300*.005+75*.04)/730,ipv4:h*.0025,perJob:dollars({machine:'c4d-highcpu-8',zone:boot.zone,provisioning:'spot',seconds,diskGb:50,diskType:'hyperdisk-balanced',egress:'external'}),west4AtSameDuration:dollars({machine:'c4d-highcpu-8',zone:'us-west4-a',provisioning:'spot',seconds,diskGb:50,diskType:'hyperdisk-balanced',egress:'external'})};
 }
 const cost=ec2Cost({...base,seconds,spotHourly:spotRate(boot.zone),initPerGib:initRate(boot.arm)});
 return {cloud:'ec2',arm:boot.arm,zone:boot.zone,seconds,...cost,per100Jobs:100*cost.total,budget180Days:180/(100*cost.total),initializationPer100Jobs:100*cost.initialization,margin20FractionPer100Jobs:100*cost.initialization/20};
});
const files=readdirSync(dir),bounds=[];
for(const file of files.filter(f=>/^i-.*-launch\.json$/.test(f))){
 const l=read(file),id=file.replace('-launch.json',''),builder=l.instance.InstanceId===read('builder.json').id;
 const terminatedFile=`${id}-terminated.json`;
 let until=files.includes(terminatedFile)?read(terminatedFile).requested:end;
 if(['i-0f4fa75335c9c0db1','i-08d52addd73b490a7'].includes(id))until=statSync(`${dir}/failed-bootstrap-terminated.json`).mtimeMs;
 // Charge all API→termination-request time plus 60 s, even pending time. Builder is charged through cleanup,
 // including its ~50 stopped minutes. This deliberately overstates actual resource usage, bounding the $10 cap.
 const seconds=(until-l.start)/1000+60;
 const cost=ec2Cost({...base,seconds,spotHourly:builder?rates.find(r=>r.kind==='compute').usd:spotRate(l.instance.Placement.AvailabilityZone),initPerGib:initRate(l.arm)});
 bounds.push({id,builder,seconds,...cost});
}
const snapshotCeiling=(end-Date.parse(snapshot.StartTime))/3600000*(snapshot.FullSnapshotSizeInBytes/2**30)*.05/730;
console.log(JSON.stringify({model:'Gross USD; 730h planning month; fresh job API insertion→job end. Excludes job termination, transfers, bake and snapshot amortization. Spike ceiling separately overcharges builder stopped time and adds 60s per instance; $0.10 extra allowance covers transfer/storage rounding.',rates,spot,snapshot:{id:snapshot.SnapshotId,volumeGiB:snapshot.VolumeSize,writtenBytes:snapshot.FullSnapshotSizeInBytes,writtenGiB:snapshot.FullSnapshotSizeInBytes/2**30},jobs,spike:{instances:bounds,snapshotCeiling,allowance:.10,totalCeiling:bounds.reduce((s,b)=>s+b.total,0)+snapshotCeiling+.10,cleaned}},null,2));
