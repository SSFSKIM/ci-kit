import test from 'node:test';
import assert from 'node:assert/strict';
import {quantile,ioDelta,stages,parseEvents,ec2Cost} from './metrics.mjs';
test('EC2 console timestamps inserted inside a JSON event do not corrupt measurements',()=>{
 assert.deepEqual(parseEvents('prefix SPIKE_JSON {"type":"bench","at":1792[2026-10-23T12:07:10.731441]757230621,"stdout":"v22.23[2026-10-23T12:07:10.731441].4"}\n'),[{type:'bench',at:1792757230621,stdout:'v22.23.4'}]);
});
test('initialization bills the entire written snapshot even when the volume is deleted in two seconds',()=>{
 const p={spotHourly:.12,ipv4Hourly:.006,diskGb:50,gp3Monthly:0,snapshotBytes:10*2**30,initPerGib:.0024};
 assert.ok(Math.abs(ec2Cost({...p,seconds:2}).initialization-.024)<1e-12);
 assert.ok(Math.abs(ec2Cost({...p,seconds:3600}).initialization-.024)<1e-12);
 assert.ok(Math.abs(ec2Cost({...p,seconds:2}).total-.0261)<1e-12);
 assert.ok(Math.abs(ec2Cost({...p,seconds:3600}).total-.15)<1e-12);
});
test('tails use nearest rank and reject an empty sample rather than report zero',()=>{
 assert.equal(quantile([10,2,4,3,7,9,5,1,8,6],.9),9);
 assert.equal(quantile([3,1,2],.5),2);
 assert.throws(()=>quantile([],.5));
});
test('disk reads count the root device once, not partitions; iowait is a CPU-time proportion',()=>{
 const b={cpu:[100,0,50,500,20,0,0,0],disk:'259 0 nvme0n1 1 0 100 0 0 0 0 0 0 0 0\n259 1 nvme0n1p1 1 0 100 0 0 0 0 0 0 0 0'};
 const a={cpu:[120,0,60,560,30,0,0,0],disk:'259 0 nvme0n1 1 0 300 0 0 0 0 0 0 0 0\n259 1 nvme0n1p1 1 0 300 0 0 0 0 0 0 0 0'};
 assert.deepEqual(ioDelta(b,a,'nvme0n1'),{readBytes:102400,iowaitPct:10});
 assert.throws(()=>ioDelta(b,a,'missing'));
});
test('stage durations come from guest timestamps, excluding checkout and polling delay',()=>{
 assert.deepEqual(stages('SPIKE_STAGE install_start 100.2\nSPIKE_STAGE install_end 105.4\nSPIKE_STAGE build_end 110.2\nSPIKE_STAGE unit_end 170.2\n'),{install:5.2,build:4.8,unit:60,total:70});
 assert.throws(()=>stages('SPIKE_STAGE install_start 100'));
});
test('prefetch is charged to end-to-end time, not hidden outside the job',()=>{
 assert.deepEqual(stages('SPIKE_STAGE prefetch_start 20\nSPIKE_STAGE prefetch_end 24\nSPIKE_STAGE install_start 24\nSPIKE_STAGE install_end 28\nSPIKE_STAGE build_end 30\nSPIKE_STAGE unit_end 40'),{prefetch:4,install:4,build:2,unit:10,total:20});
});
