#!/usr/bin/env node
// Real, disposable PostgreSQL 17 on a private Unix socket; no Supabase credentials.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const dir=mkdtempSync('/tmp/munhae-pg-data-tests-');
const env={...process.env};for(const k of Object.keys(env))if(k.startsWith('PG'))delete env[k];
const args=['-X','-q','-v','ON_ERROR_STOP=1','-h',dir,'-p','55440','-U','postgres','-d','postgres'];
let started=false;
function run(command,args,input){const r=spawnSync(command,args,{env,input,encoding:'utf8',maxBuffer:8*1024*1024});if(r.error||r.status!==0)throw new Error(r.stderr||r.stdout||r.error?.message);return r.stdout.trim();}
function sql(s){return run('psql',args,s);}
const lit=value=>"'"+String(value).replaceAll("'","''")+"'";
function parallelSql(input,onOutput=()=>{}){return new Promise((resolve,reject)=>{const p=spawn('psql',[...args,'-At'],{env});let out='',err='';p.stdout.on('data',c=>{out+=c;onOutput(out);});p.stderr.on('data',c=>err+=c);p.on('error',reject);p.on('close',code=>code===0?resolve(out.trim()):reject(new Error(err)));p.stdin.end(input);});}
async function fixtures(){
 const requireDesktop=createRequire(join(root,'apps/desktop/package.json'));
 const requireDb=createRequire(join(root,'packages/db-sqlite/package.json'));
 const {build}=createRequire(requireDesktop.resolve('vite'))('esbuild');const bundle=join(dir,'fixtures.cjs'),target=join(dir,'fixtures.json');
 await build({stdin:{contents:`
 import {mkdirSync,writeFileSync} from 'node:fs';
 import {seedDemoProject,createProject} from ${JSON.stringify(join(root,'packages/db-sqlite/src/index.ts'))};
 const parent=${JSON.stringify(dir)};mkdirSync(parent+'/seed');mkdirSync(parent+'/rich');
 const demo=seedDemoProject(parent+'/seed');const seeded=demo.exportOnlineRows();demo.close();
 const repo=createProject({parentDir:parent+'/rich',title:'공유 문헌'}).handle;
 const doc=repo.createDocument({parentId:null,title:'원문',nodeRole:'source_unit',sourceText:'學而時習之',originKind:'paste'});
 repo.createDocument({parentId:null,title:'별도 원문',nodeRole:'source_unit',sourceText:'不亦說乎',originKind:'paste'});
 const run=repo.beginFullTextRun({documentNodeId:doc.id,agentId:'codex',requestedModel:null,reasoningLevel:null,serviceTier:null,runtimeVersion:null});
 repo.completeFullTextRun({messageId:run.messageId,rawResponse:JSON.stringify({schemaVersion:1,translation:'배우고 때때로 익힌다.'}),eventsJsonl:'',usage:null,resolvedModel:null,runtimeVersion:null});
 const editor=repo.getEditor(doc.id);
 repo.createReviewComment({documentNodeId:doc.id,translationVersionId:editor.translation.versionId,targetKind:'source',targetVersionId:editor.source.versionId,codepointFrom:0,codepointTo:1,quote:'學',bodyMd:'배움'});
 repo.saveTerm({documentId:doc.id,sourceVersion:editor.source.versionId+':'+editor.source.lockVersion,sourceForm:'學',kind:'concept',reading:'학',translation:null,definition:'배움',contextNote:null,selectionReason:null,uncertainty:null,evidence:[],quotes:['學'],status:'draft'});
 const rich=repo.exportOnlineRows();repo.close();writeFileSync(${JSON.stringify(target)},JSON.stringify([seeded,rich]));
 `,resolveDir:root},bundle:true,platform:'node',format:'cjs',outfile:bundle,logLevel:'silent',plugins:[{name:'native-sqlite',setup(build){build.onResolve({filter:/^better-sqlite3$/},()=>({path:requireDb.resolve('better-sqlite3'),external:true}));}}]});
 const electron=requireDesktop('electron');const r=spawnSync(electron,[bundle],{env:{...env,ELECTRON_RUN_AS_NODE:'1'},encoding:'utf8'});if(r.status!==0)throw new Error(r.stderr||r.stdout);return JSON.parse(readFileSync(target,'utf8'));
}
try{
 run('initdb',['-D',join(dir,'data'),'-U','postgres','-A','trust','--no-instructions','--locale=C','--encoding=UTF8']);
 run('pg_ctl',['-D',join(dir,'data'),'-l',join(dir,'postgres.log'),'-o',`-F -c listen_addresses='' -k ${dir} -p 55440`,'-w','start']);started=true;
 sql(`create role anon;create role authenticated;create role service_role bypassrls;
 create schema auth;create table auth.users(id uuid primary key);
 create function auth.uid() returns uuid language sql stable as $$select (nullif(current_setting('request.jwt.claims',true),'')::jsonb->>'sub')::uuid$$;
 create schema storage;create table storage.buckets(id text primary key,name text not null,public boolean not null default false,file_size_limit bigint,allowed_mime_types text[]);
 create table storage.objects(id uuid primary key default gen_random_uuid(),bucket_id text not null,name text not null,metadata jsonb not null default '{}',user_metadata jsonb not null default '{}',unique(bucket_id,name));
 alter table storage.objects enable row level security;
 grant usage on schema auth,public,storage to anon,authenticated;grant execute on function auth.uid() to anon,authenticated;
 grant select,insert,update,delete on storage.objects to anon,authenticated;
 alter default privileges in schema public grant all on tables to anon,authenticated,service_role;
 alter default privileges in schema public grant execute on functions to anon,authenticated,service_role;
 create publication supabase_realtime;`);
 for(const name of ['20260922110336_online_projects.sql','20260922112658_online_project_workspaces.sql','20260922121922_online_postgres.sql'])sql(readFileSync(join(root,'supabase/migrations',name),'utf8'));
 const countIndexes=()=>Number(run('psql',[...args,'-At'],"select count(*) from pg_index i join pg_class c on c.oid=i.indrelid where starts_with(c.relname,'online_data_')"));
 const countBefore=countIndexes();
 const cleanup=readFileSync(join(root,'supabase/migrations/20260922122434_online_postgres_indexes.sql'),'utf8');
 sql(cleanup);
 assert.equal(countBefore-countIndexes(),113,'Remove only the 113 known exact duplicate index copies');
 sql(cleanup);assert.equal(countBefore-countIndexes(),113,'Cleanup is idempotent');
 // Deliberately similar indexes must remain distinct. A real constraint backing
 // index and an explicitly clustered index always win over unprotected copies.
 sql(`create unique index od_test_pk_copy on public.online_data_core_actors(online_project_id,id);
 create index od_test_clustered on public.online_data_core_actors(online_project_id,display_name);
 alter table public.online_data_core_actors cluster on od_test_clustered;
 create index od_test_cluster_copy on public.online_data_core_actors(online_project_id,display_name);
 create index od_test_pattern on public.online_data_core_actors(online_project_id,display_name text_pattern_ops);
 create index od_test_desc on public.online_data_core_actors(online_project_id,display_name desc);
 create index od_test_collation on public.online_data_core_actors(online_project_id,display_name collate "C");
 create index od_test_include on public.online_data_core_actors(online_project_id,display_name) include(created_at);
 create index od_test_partial_human on public.online_data_core_actors(online_project_id,display_name) where actor_kind='human';
 create index od_test_partial_llm on public.online_data_core_actors(online_project_id,display_name) where actor_kind='llm';
 create index od_test_lower on public.online_data_core_actors(online_project_id,lower(display_name));
 create index od_test_upper on public.online_data_core_actors(online_project_id,upper(display_name));
 create index od_test_options on public.online_data_core_actors(online_project_id,display_name) with(fillfactor=80);`);
 sql(cleanup);
 assert.equal(run('psql',[...args,'-At'],"select count(*) from pg_class where relname like 'od_test_%'"),'10','Only two exact, unprotected test copies may be removed');
 assert.equal(run('psql',[...args,'-At'],"select count(*) from pg_index i join pg_class c on c.oid=i.indrelid where starts_with(c.relname,'online_data_') and i.indisprimary"),'48','All primary-key backing indexes survive');
 assert.equal(run('psql',[...args,'-At'],"select indisclustered from pg_index where indexrelid='public.od_test_clustered'::regclass"),'t');
 sql(readFileSync(join(root,'supabase/tests/online_postgres.sql'),'utf8'));
 assert.equal(run('psql',[...args,'-At'],"select count(*) from public.online_projects"),'0');
 assert.equal(run('psql',[...args,'-At'],"select count(*) from auth.users"),'0');
 const metadata=JSON.parse(readFileSync(join(root,'scripts/online-postgres-schema.json'),'utf8'));
 const owner='00000000-0000-4000-8000-000000000011';sql(`insert into auth.users values('${owner}');`);
 const authenticated=statement=>`begin;set local role authenticated;set local request.jwt.claims='{"sub":"${owner}"}';${statement};commit;`;
 const dataSets=await fixtures();
 const historical=structuredClone(dataSets[1]);
 const commentDocument=historical.review_comments[0].document_node_id;
 historical.document_nodes.find(n=>n.id===commentDocument).archived_at='2026-09-22T01:00:00.000Z';
 dataSets.push(historical);
 for(const [i,tables] of dataSets.entries()){
  const project=`00000000-0000-4000-8000-00000000011${i}`;
  sql(`insert into public.online_projects(id,owner_id,title,request_id) values('${project}','${owner}','Roundtrip',gen_random_uuid());`);
  const changes=metadata.tables.flatMap(t=>tables[t.name].map(after=>({table:t.name,key:Object.fromEntries(t.primaryKey.map(k=>[k,after[k]])),before:null,after})));
  const argsText=`'${project}',0,'00000000-0000-4000-8000-00000000021${i}',10,${lit(JSON.stringify(changes))}`;
  if(i===1){
   const lease='00000000-0000-4000-8000-000000000311';
   sql(`insert into public.online_project_workspaces(project_id,owner_id,lease_id,lease_expires_at,fence,revision,object_path,sha256,byte_size) values('${project}','${owner}','${lease}',now()+interval '120 seconds',1,1,'recovery.munhaepkg',repeat('a',64),32);`);
   assert.throws(()=>sql(authenticated(`select public.commit_online_project_data(${argsText})`)),/ONLINE_DATA_LEGACY_LEASE_LOST/);
   assert.throws(()=>sql(authenticated(`select public.commit_online_project_data(${argsText},'${lease}',2)`)),/ONLINE_DATA_LEGACY_LEASE_LOST/);
   sql(authenticated(`select public.commit_online_project_data(${argsText},'${lease}',1)`));
   // A lost successful response stays idempotent after release/expiry.
   sql(`update public.online_project_workspaces set lease_expires_at=now()-interval '1 second' where project_id='${project}';`);
   sql(authenticated(`select public.commit_online_project_data(${argsText},'${lease}',1)`));
  }else sql(authenticated(`select public.commit_online_project_data(${argsText})`));
  const response=JSON.parse(run('psql',[...args,'-At'],authenticated(`select public.get_online_project_data('${project}')`)));
  for(const t of metadata.tables){const sort=rows=>rows.toSorted((a,b)=>JSON.stringify(t.primaryKey.map(k=>a[k])).localeCompare(JSON.stringify(t.primaryKey.map(k=>b[k]))));assert.deepEqual(sort(response.tables[t.name]),sort(tables[t.name]),`Scalar-preserving PG roundtrip: ${t.name}`);}
  if(i===1){
   const nodes=tables.document_nodes.filter(n=>n.parent_node_id!==null&&n.archived_at===null);
   assert(nodes.length>=2);const [a,b]=nodes;
   const reorder=[{table:'document_nodes',key:{id:a.id},before:a,after:{...a,ordinal:b.ordinal}},{table:'document_nodes',key:{id:b.id},before:b,after:{...b,ordinal:a.ordinal}}];
   sql(authenticated(`select public.commit_online_project_data('${project}',1,gen_random_uuid(),10,${lit(JSON.stringify(reorder))})`));
   let signal;const acquired=new Promise(r=>signal=r);
   const first=parallelSql(authenticated(`select public.commit_online_project_data('${project}',2,'00000000-0000-4000-8000-000000000411',10,'[]');select pg_sleep(0.2)`),out=>{if(out.includes('revision'))signal();});
   await Promise.race([acquired,first]);
   await Promise.all([first,assert.rejects(parallelSql(authenticated(`select public.commit_online_project_data('${project}',2,'00000000-0000-4000-8000-000000000412',10,'[]')`)),/ONLINE_DATA_REVISION_CONFLICT/)]);
   assert.equal(JSON.parse(run('psql',[...args,'-At'],authenticated(`select public.get_online_project_changes('${project}',2)`))).revision,3);
  }
 }
 console.log('Online PostgreSQL: 48-table demo/AI/comment/term roundtrips, deferred reorder, concurrent CAS, legacy lease fencing, ownership, rollback, journal and immutable assets passed.');
}catch(error){console.error(error.message);process.exitCode=1;}
finally{if(started)run('pg_ctl',['-D',join(dir,'data'),'-m','fast','-w','stop']);rmSync(dir,{recursive:true,force:true});}
