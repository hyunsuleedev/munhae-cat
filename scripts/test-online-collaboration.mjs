#!/usr/bin/env node
// A disposable PostgreSQL cluster, listening only on its own Unix socket.
// Does not connect to the linked Supabase project or use its credentials.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const temporary = mkdtempSync('/tmp/munhae-collaboration-tests-');
const data = join(temporary, 'data');
const env = { ...process.env, ELECTRON_RUN_AS_NODE: '1' };
for (const key of Object.keys(env)) if (key.startsWith('PG')) delete env[key];
const psqlArgs = ['-X', '-q', '-v', 'ON_ERROR_STOP=1', '-h', temporary, '-p', '55439', '-U', 'postgres', '-d', 'postgres'];
let started = false;

function run(command, args, input) {
  const result = spawnSync(command, args, { encoding: 'utf8', env, input });
  if (result.error || result.status !== 0) {
    throw new Error(`${command} failed: ${result.error?.message || result.stderr || result.stdout}`);
  }
  return result.stdout.trim();
}
function sql(input) { return run('psql', psqlArgs, input); }
function concurrentSql(input, onOutput = () => {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn('psql', [...psqlArgs, '-At'], { env });
    let output = '', error = '';
    child.stdout.on('data', (chunk) => { output += chunk; onOutput(output); });
    child.stderr.on('data', (chunk) => { error += chunk; });
    child.on('error', reject);
    child.on('exit', (code) => code === 0 ? resolvePromise(output.trim()) : reject(new Error(error || `psql exited ${code}`)));
    child.stdin.end(input);
  });
}

try {
  run('initdb', ['-D', data, '-U', 'postgres', '-A', 'trust', '--no-instructions', '--locale=C', '--encoding=UTF8']);
  run('pg_ctl', ['-D', data, '-l', join(temporary, 'postgres.log'), '-o', `-F -c listen_addresses='' -k ${temporary} -p 55439`, '-w', 'start']);
  started = true;
  sql(`
    create role anon;
    create role authenticated;
    create role service_role bypassrls;
    create schema auth;
    create table auth.users (id uuid primary key);
    create function auth.uid() returns uuid language sql stable as
      $$ select (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')::uuid $$;
    create schema storage;
    create table storage.buckets (
      id text primary key, name text not null, public boolean not null default false,
      file_size_limit bigint, allowed_mime_types text[]
    );
    create table storage.objects (
      id uuid primary key default gen_random_uuid(), bucket_id text not null,
      name text not null, metadata jsonb not null default '{}',
      user_metadata jsonb not null default '{}', unique (bucket_id, name)
    );
    alter table storage.objects enable row level security;
    grant usage on schema storage to anon, authenticated;
    grant select, insert, update, delete on storage.objects to anon, authenticated;
  `);
  sql(`
    grant usage on schema auth, public to anon, authenticated;
    grant execute on function auth.uid() to anon, authenticated;
    alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
    alter default privileges in schema public grant execute on functions to anon, authenticated, service_role;
  `);
  sql(readFileSync(join(root, 'supabase/migrations/20260922110336_online_projects.sql'), 'utf8'));
  sql(readFileSync(join(root, 'supabase/migrations/20260922112658_online_project_workspaces.sql'), 'utf8'));

  sql(`alter table auth.users add email text, add email_confirmed_at timestamptz, add is_anonymous boolean default false, add raw_user_meta_data jsonb default '{}';`);
  for (const migration of ['20260922121922_online_postgres.sql','20260922222326_stripe_billing.sql','20260923114543_online_project_collaboration.sql','20260923115909_online_collaboration_rpc_boundary.sql']) sql(readFileSync(join(root,'supabase/migrations',migration),'utf8'));
  sql(readFileSync(join(root,'supabase/tests/online_project_collaboration.sql'),'utf8'));
  // Concurrent owners' sessions must not both take the final seat.
  const owner='10000000-0000-4000-8000-000000000001', project='20000000-0000-4000-8000-000000000001';
  sql(`insert into auth.users(id,email,email_confirmed_at) values('${owner}','owner@example.com',now());
    insert into public.online_projects(id,owner_id,title,request_id) values('${project}','${owner}','Race',gen_random_uuid());
    insert into public.online_project_data(project_id,data_project_id,revision) values('${project}','race',1);
    insert into public.billing_customers(user_id,stripe_account_id,livemode,stripe_customer_id) values('${owner}','acct_1UEFAWA3GOt8qQ7V',true,'cus_race');
    insert into public.billing_subscriptions(user_id,stripe_account_id,livemode,stripe_customer_id,stripe_subscription_id,stripe_price_id,status,current_period_end) values('${owner}','acct_1UEFAWA3GOt8qQ7V',true,'cus_race','sub_race','price_1UIo0vA3GOt8qQ7V5uVosHAW','active',now()+interval '1 month');
    insert into public.online_project_invitations(project_id,email,role,invited_by) select '${project}','pending'||n||'@example.com','viewer','${owner}' from generate_series(1,3)n;`);
  const asOwner = statement => `begin;set local role authenticated;set local request.jwt.claims='{"sub":"${owner}"}';${statement};commit;`;
  const race=await Promise.allSettled(['last1@example.com','last2@example.com'].map(email=>concurrentSql(asOwner(`select public.invite_online_project_member('${project}','${email}','viewer')`))));
  assert.equal(race.filter(x=>x.status==='fulfilled').length,1,'Only one concurrent invite can reserve the final seat');
  assert.equal(race.filter(x=>x.status==='rejected' && String(x.reason).includes('COLLAB_MEMBER_LIMIT')).length,1);
  assert.equal(run('psql',[...psqlArgs,'-At'],`select count(*) from public.online_project_invitations where project_id='${project}' and status='pending'`),'4');
  // Seed a real desktop export, then commit as a different authenticated editor.
  const requireDesktop=createRequire(join(root,'apps/desktop/package.json'));
  const requireDb=createRequire(join(root,'packages/db-sqlite/package.json'));
  const {build}=createRequire(requireDesktop.resolve('vite'))('esbuild');
  const bundle=join(temporary,'fixture.cjs'),target=join(temporary,'fixture.json');
  await build({stdin:{contents:`import {writeFileSync} from 'node:fs'; import {createProject} from ${JSON.stringify(join(root,'packages/db-sqlite/src/index.ts'))}; const repo=createProject({parentDir:${JSON.stringify(temporary)},title:'Collaboration test'}).handle; repo.createDocument({parentId:null,title:'Source',nodeRole:'source_unit',sourceText:'學而時習之',originKind:'paste'}); writeFileSync(${JSON.stringify(target)},JSON.stringify(repo.exportOnlineRows()));repo.close();`,resolveDir:root},bundle:true,platform:'node',format:'cjs',outfile:bundle,logLevel:'silent',plugins:[{name:'native-sqlite',setup(build){build.onResolve({filter:/^better-sqlite3$/},()=>({path:requireDb.resolve('better-sqlite3'),external:true}));}}]});
  run(requireDesktop('electron'),[bundle]);
  const tables=JSON.parse(readFileSync(target,'utf8'));
  const metadata=JSON.parse(readFileSync(join(root,'scripts/online-postgres-schema.json'),'utf8'));
  const owner2='10000000-0000-4000-8000-000000000011',editor='10000000-0000-4000-8000-000000000012',pid='20000000-0000-4000-8000-000000000011';
  sql(`insert into auth.users(id,email,email_confirmed_at) values('${owner2}','owner2@example.com',now()),('${editor}','editor@example.com',now());insert into public.online_projects(id,owner_id,title,request_id) values('${pid}','${owner2}','Write test',gen_random_uuid());`);
  const lit=value=>"'"+String(value).replaceAll("'","''")+"'";
  const asUser=(user,statement)=>`begin;set local role authenticated;set local request.jwt.claims='{"sub":"${user}"}';${statement};commit;`;
  const changes=metadata.tables.flatMap(t=>tables[t.name].map(after=>({table:t.name,key:Object.fromEntries(t.primaryKey.map(k=>[k,after[k]])),before:null,after})));
  sql(asUser(owner2,`select public.commit_online_project_data('${pid}',0,gen_random_uuid(),10,${lit(JSON.stringify(changes))})`));
  sql(`insert into public.online_project_members values('${pid}','${editor}','editor',now());`);
  const before=tables.src_text_versions.find(v=>v.state==='draft');assert(before,'real fixture has editable source');
  const edit=[{table:'src_text_versions',key:{id:before.id},before,after:{...before,content_text:'學而時習之。'}}];
  sql(asUser(editor,`select public.commit_online_project_data('${pid}',1,gen_random_uuid(),10,${lit(JSON.stringify(edit))})`));
  assert.equal(run('psql',[...psqlArgs,'-At'],`select content_text from public.online_data_src_text_versions where online_project_id='${pid}' and id=${lit(before.id)}`),'學而時習之。');
  console.log('Collaboration SQL: invitation lifecycle, role isolation, premium scope, storage, RPC and concurrent seat limits passed.');
} finally {
  if (started) spawnSync('pg_ctl',['-D',data,'-m','immediate','-w','stop'],{env,stdio:'ignore'});
  rmSync(temporary,{recursive:true,force:true});
}
