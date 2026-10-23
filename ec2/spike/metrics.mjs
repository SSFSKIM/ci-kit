// Pure calculations used by the M1 verdict. Durations are seconds, disk sectors are always 512 bytes.
export function parseEvents(text){
 const clean=text.replace(/\[\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d+\]/g,'');
 const events=[];
 for(const m of clean.matchAll(/SPIKE_JSON (\{[^\r\n]*\})/g)){
  try{events.push(JSON.parse(m[1]));}catch{} // A serial-buffer boundary can truncate one observation; a later one repeats it.
 }
 return events;
}
export function ec2Cost({seconds,spotHourly,ipv4Hourly=.005,diskGb=50,gp3Monthly=.08,snapshotBytes=0,initPerGib=0}){
 const hours=Math.max(60,seconds)/3600;
 const compute=hours*spotHourly,disk=hours*diskGb*gp3Monthly/730,ipv4=hours*ipv4Hourly;
 const initialization=snapshotBytes/2**30*initPerGib;
 return {compute,disk,ipv4,initialization,total:compute+disk+ipv4+initialization};
}
export function quantile(values,p){
 if(!values.length||values.some(v=>!Number.isFinite(v)))throw Error('no finite sample');
 return [...values].sort((a,b)=>a-b)[Math.max(0,Math.ceil(p*values.length)-1)];
}
export function ioDelta(before,after,device){
 const sectors=(s)=>{const row=s.disk.split('\n').map(l=>l.trim().split(/\s+/)).find(r=>r[2]===device);if(!row)throw Error(`missing device ${device}`);return Number(row[5]);};
 // guest/guest_nice already contribute to user/nice: Linux's first eight columns are the denominator.
 const d=after.cpu.slice(0,8).map((v,i)=>v-before.cpu[i]);
 return {readBytes:(sectors(after)-sectors(before))*512,iowaitPct:100*d[4]/d.reduce((a,b)=>a+b,0)};
}
export function stages(stdout){
 const t=Object.fromEntries([...stdout.matchAll(/SPIKE_STAGE (\w+) ([\d.]+)/g)].map(m=>[m[1],Number(m[2])]));
 if(['install_start','install_end','build_end','unit_end'].some(k=>!Number.isFinite(t[k])))throw Error('incomplete stages');
 const r=(v)=>Math.round(v*1000)/1000;
 const prefetch=t.prefetch_start===undefined?0:t.prefetch_end-t.prefetch_start;
 if(!Number.isFinite(prefetch)||prefetch<0)throw Error('incomplete prefetch');
 return {...(t.prefetch_start===undefined?{}:{prefetch:r(prefetch)}),install:r(t.install_end-t.install_start),build:r(t.build_end-t.install_end),unit:r(t.unit_end-t.build_end),total:r(t.unit_end-t.install_start+prefetch)};
}
