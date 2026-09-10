import {S3Client, HeadObjectCommand, PutObjectCommand} from '@aws-sdk/client-s3';
import {createReadStream} from 'node:fs';
import {readFile,stat,writeFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {digestFile,stableVersion} from './release-utils.mjs';
const root=fileURLToPath(new URL('../../',import.meta.url));
const dir=resolve(root,'apps/desktop/release');
const version=stableVersion(JSON.parse(await readFile(resolve(root,'apps/desktop/package.json'))).version);
const required=name=>{if(!process.env[name])throw Error(`Missing ${name}`);return process.env[name];};
const bucket=required('R2_BUCKET');
if(bucket!=='munhae-releases')throw Error('Unexpected release bucket');
const client=new S3Client({region:'auto',endpoint:`https://${required('R2_ACCOUNT_ID')}.r2.cloudflarestorage.com`,credentials:{accessKeyId:required('R2_ACCESS_KEY_ID'),secretAccessKey:required('R2_SECRET_ACCESS_KEY')},requestChecksumCalculation:'WHEN_REQUIRED',responseChecksumValidation:'WHEN_REQUIRED'});
const sums=[];
for(const arch of ['arm64','x64']){
 const name=`Munhae Studio-${version}-${arch}.dmg`,file=resolve(dir,name),key=`mac/${arch}/${name}`;
 const digest=await digestFile(file,'sha256','hex');
 sums.push(`${digest}  ${name}`);
 if(!process.argv.includes('--publish')){console.log(`Ready ${key}`);continue;}
 let exists=false;
 try{const head=await client.send(new HeadObjectCommand({Bucket:bucket,Key:key}));if(head.Metadata?.sha256!==digest)throw Error(`Existing artifact differs: ${key}`);exists=true;}catch(e){if(e.$metadata?.httpStatusCode!==404)throw e;}
 if(!exists)await client.send(new PutObjectCommand({Bucket:bucket,Key:key,Body:createReadStream(file),ContentLength:(await stat(file)).size,ContentType:'application/x-apple-diskimage',ContentDisposition:`attachment; filename="Munhae-Studio-${version}-${arch}.dmg"`,CacheControl:'public, max-age=31536000, immutable',Metadata:{sha256:digest},IfNoneMatch:'*'}));
 const url=`https://download.munhaestudio.com/${key.split('/').map(encodeURIComponent).join('/')}`;
 const response=await fetch(url,{signal:AbortSignal.timeout(180000)});if(!response.ok)throw Error(`Public download failed: ${response.status}`);
 const hash=createHash('sha256');for await(const chunk of response.body)hash.update(chunk);if(hash.digest('hex')!==digest)throw Error('Public hash mismatch');
 console.log(`Uploaded and publicly verified: ${url}`);
}
await writeFile(resolve(dir,'SHA256SUMS-mac.txt'),sums.join('\n')+'\n');
