// node ec2/spike/summarize.mjs /path/to/private/state > sanitized-evidence.json
import {readdirSync,readFileSync} from 'node:fs';
import {quantile,ioDelta,stages,parseEvents} from './metrics.mjs';
const dir=process.argv[2];
const files=readdirSync(dir),events=new Map();
for(const f of files.filter(f=>/^(i-|ci-kit-spike-).+\.(console|jsonl)$/.test(f))){
 const s=readFileSync(`${dir}/${f}`,'utf8');
 const rows=parseEvents(f.endsWith('.jsonl')?s.split('\n').map(l=>'SPIKE_JSON '+l).join('\n'):s);
 for(const row of rows){const e={...row,id:f.replace(/\.(console|jsonl)$/,'')};events.set(`${e.id}/${e.type}/${e.at}`,e);}
}
const launches=files.filter(f=>f.endsWith('-launch.json')).map(f=>({id:f.replace('-launch.json',''),...JSON.parse(readFileSync(`${dir}/${f}`))}));
const guests=[...events.values()].filter(e=>e.type==='guest').sort((a,b)=>a.at-b.at);
const boots=guests.map(g=>{
 const l=launches.find(l=>l.id===g.id);
 const es=[...events.values()].filter(e=>e.id===g.id);
 const listening=es.find(e=>e.type==='listening'),container=es.find(e=>e.type==='container');
 return {id:l?.id,cloud:g.cloud,arm:l?.arm??'plain',zone:l?.instance?.Placement?.AvailabilityZone??l?.result?.zone?.split('/').pop(),apiStart:l?.start,accepted:l?.accepted,boot:g.at-g.uptime*1000,guest:g.at,container:container?.at,listening:listening?.at,node:g.node,kernel:g.kernel,kit:g.kit,warm:g.warm,
  apiToGuest:l?(g.at-l.start)/1000:null,apiToListening:l&&listening?(listening.at-l.start)/1000:null,bootToGuest:g.uptime,bootToListening:listening?.uptime};
});
const benches=[...events.values()].filter(e=>e.type==='bench').map(e=>{
 const root=e.before.disk.split('\n').map(l=>l.trim().split(/\s+/)[2]).find(d=>/^nvme\d+n\d+$/.test(d))??'sda';
 let durations;try{durations=stages(e.stdout);}catch{}
 return {id:e.id,cloud:e.cloud,arm:launches.find(l=>l.id===e.id)?.arm??'plain',n:e.n,start:e.start,end:e.end,status:e.status,wall:(e.end-e.start)/1000,...durations,...ioDelta(e.before,e.after,root),device:root,toolchain:e.stdout?.match(/SPIKE_TOOLCHAIN[^\n]*\n[^\n]*/)?.[0],summary:e.stdout?.replace(/\u001b\[[0-9;]*m/g,'').split('\n').filter(l=>/Test Files|Tests\s+\d/.test(l))};
}).sort((a,b)=>a.start-b.start);
const stats=(xs)=>xs.length?{n:xs.length,p50:quantile(xs,.5),p90:quantile(xs,.9)}:null;
const groups=[...new Set(boots.map(b=>`${b.cloud}/${b.arm}`))];
const bootStats=Object.fromEntries(groups.map(group=>{
 const rows=boots.filter(b=>`${b.cloud}/${b.arm}`===group&&b.apiToListening!==null);
 const deltas={apiRoundTrip:b=>(b.accepted-b.apiStart)/1000,apiToKernel:b=>(b.boot-b.apiStart)/1000,kernelToGuest:b=>b.bootToGuest,guestToContainer:b=>b.container?(b.container-b.guest)/1000:null,containerToListening:b=>b.container?(b.listening-b.container)/1000:null,guestToListening:b=>(b.listening-b.guest)/1000,apiToListening:b=>b.apiToListening};
 return [group,Object.fromEntries(Object.entries(deltas).map(([stage,fn])=>[stage,stats(rows.map(fn).filter(v=>v!==null&&Number.isFinite(v)))]))];
}));
const unitStats=Object.fromEntries(['ec2','gce'].map(cloud=>[cloud,stats(benches.filter(b=>b.cloud===cloud&&b.arm==='plain'&&b.n>0&&b.status===0&&Number.isFinite(b.unit)).map(b=>b.unit))]));
console.log(JSON.stringify({boots,benches,bootStats,unitStats},null,2));
