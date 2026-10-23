// Prove the production-shaped four-hour Google→AWS exchange. Prints claims and expiration, never credentials.
import {execFileSync} from 'node:child_process';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
const audience='https://ci-kit/290475840169/ec2';
const account='ci-kit-launcher@ssfskim-ci-kit.iam.gserviceaccount.com';
const env={...process.env,AWS_PROFILE:'ci-kit-ops',AWS_REGION:'us-east-2',AWS_PAGER:''};
const run=(bin,args,extra={})=>{try{return execFileSync(bin,args,{encoding:'utf8',env:{...env,...extra},stdio:['ignore','pipe','pipe']}).trim();}catch(e){throw Error(`${bin}: ${e.stderr}`);}};
const dir=mkdtempSync(join(tmpdir(),'ci-kit-federation-'));
try{
 const jwt=run('gcloud',['auth','print-identity-token',`--impersonate-service-account=${account}`,`--audiences=${audience}`,'--include-email']);
 const {sub,azp,aud,email}=JSON.parse(Buffer.from(jwt.split('.')[1],'base64url'));
 if(aud!==audience||email!==account||!sub||!azp)throw Error('unexpected real ID-token claims');
 const trust={Version:'2012-10-17',Statement:[{Effect:'Allow',Principal:{Federated:'accounts.google.com'},Action:'sts:AssumeRoleWithWebIdentity',Condition:{StringEquals:{'accounts.google.com:sub':sub,'accounts.google.com:aud':azp,'accounts.google.com:oaud':aud}}}]};
 writeFileSync(join(dir,'token'),jwt,{mode:0o600});writeFileSync(join(dir,'trust.json'),JSON.stringify(trust));
 run('bash',[fileURLToPath(new URL('../setup.sh',import.meta.url))],{SPIKE_TRUST_FILE:join(dir,'trust.json')});
 const began=new Date().toISOString();
 const proof=JSON.parse(run('aws',['sts','assume-role-with-web-identity','--role-arn','arn:aws:iam::290475840169:role/ci-kit-ec2-spike','--role-session-name','ec2-m1','--web-identity-token',`file://${join(dir,'token')}`,'--duration-seconds','14400','--query','{role:AssumedRoleUser.Arn,expiration:Credentials.Expiration,subject:SubjectFromWebIdentityToken,audience:Audience}','--output','json']));
 const maximum=Number(run('aws',['iam','get-role','--role-name','ci-kit-ec2-spike','--query','Role.MaxSessionDuration','--output','text']));
 console.log(JSON.stringify({began,claims:{sub,azp,aud,email},requestedDurationSeconds:14400,maxSessionDuration:maximum,proof},null,2));
}finally{rmSync(dir,{recursive:true,force:true});}
