#!/usr/bin/env node
// A disposable PostgreSQL cluster, listening only on its own Unix socket.
// Does not connect to the linked Supabase project or use its credentials.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const temporary = mkdtempSync('/tmp/munhae-online-tests-');
const data = join(temporary, 'data');
const env = { ...process.env };
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
  sql(readFileSync(join(root, 'supabase/tests/online_projects.sql'), 'utf8'));
  sql(readFileSync(join(root, 'supabase/tests/online_project_workspaces.sql'), 'utf8'));
  assert.equal(run('psql', [...psqlArgs, '-At'], 'select count(*) from public.online_projects;'), '0');
  assert.equal(run('psql', [...psqlArgs, '-At'], 'select count(*) from auth.users;'), '0');
  assert.equal(run('psql', [...psqlArgs, '-At'], 'select count(*) from public.online_project_workspaces;'), '0');
  assert.equal(run('psql', [...psqlArgs, '-At'], 'select count(*) from storage.objects;'), '0');

  sql("insert into auth.users values ('00000000-0000-4000-8000-000000000003');");
  const transaction = (hold) => `
    begin;
    set local role authenticated;
    set local request.jwt.claims = '{"sub":"00000000-0000-4000-8000-000000000003"}';
    select id from public.create_online_project('동시 생성', '', '00000000-0000-4000-8000-000000000030');
    ${hold ? 'select pg_sleep(0.5);' : ''}
    commit;
  `;
  let notifyInserted;
  const inserted = new Promise((resolvePromise) => { notifyInserted = resolvePromise; });
  const first = concurrentSql(transaction(true), (output) => {
    if (/[0-9a-f]{8}-[0-9a-f-]{27}/.test(output)) notifyInserted();
  });
  await Promise.race([inserted, first]);
  const ids = await Promise.all([first, concurrentSql(transaction(false))]);
  assert.equal(ids[0], ids[1], 'Concurrent retries must return the same project');
  const count = run('psql', [...psqlArgs, '-At'], 'select count(*) from public.online_projects;');
  assert.equal(count, '1', 'Concurrent requests must create one project');
  const projectId = run('psql', [...psqlArgs, '-At'], 'select id from public.online_projects limit 1;');
  const owner = '00000000-0000-4000-8000-000000000003';
  const lease = '00000000-0000-4000-8000-000000000601';
  const leaseTransaction = (otherLease, hold) => `
    begin;
    set local role authenticated;
    set local request.jwt.claims = '{"sub":"${owner}"}';
    select fence from public.acquire_online_workspace('${projectId}', '${otherLease}');
    ${hold ? 'select pg_sleep(0.5);' : ''}
    commit;
  `;
  let notifyAcquired;
  const acquired = new Promise((resolvePromise) => { notifyAcquired = resolvePromise; });
  const firstLease = concurrentSql(leaseTransaction(lease, true), () => notifyAcquired());
  await Promise.race([acquired, firstLease]);
  await Promise.all([
    firstLease,
    assert.rejects(concurrentSql(leaseTransaction('00000000-0000-4000-8000-000000000602', false)), /ONLINE_WORKSPACE_LOCKED/),
  ]);
  const paths = ['00000000-0000-4000-8000-000000000701', '00000000-0000-4000-8000-000000000702']
    .map((checkpoint) => `${owner}/${projectId}/1/${checkpoint}.munhaepkg`);
  sql(`insert into storage.objects (bucket_id, name, metadata, user_metadata) values
    ${paths.map((path) => `('online-project-workspaces','${path}','{"size":32,"mimetype":"application/zip"}','{"lease_id":"${lease}"}')`).join(',')};`);
  const commitTransaction = (path, hold) => `
    begin;
    set local role authenticated;
    set local request.jwt.claims = '{"sub":"${owner}"}';
    select revision from public.commit_online_workspace('${projectId}','${lease}',1,0,'${path}',repeat('a',64),32);
    ${hold ? 'select pg_sleep(0.5);' : ''}
    commit;
  `;
  let notifyCommitted;
  const committed = new Promise((resolvePromise) => { notifyCommitted = resolvePromise; });
  const firstCommit = concurrentSql(commitTransaction(paths[0], true), () => notifyCommitted());
  await Promise.race([committed, firstCommit]);
  await Promise.all([
    firstCommit,
    assert.rejects(concurrentSql(commitTransaction(paths[1], false)), /ONLINE_WORKSPACE_CONFLICT/),
  ]);
  assert.equal(run('psql', [...psqlArgs, '-At'], 'select revision from public.online_project_workspaces;'), '1');
  assert.equal(run('psql', [...psqlArgs, '-At'], 'select object_path from public.online_project_workspaces;'), paths[0]);
  assert.equal(run('psql', [...psqlArgs, '-At'], 'select count(*) from storage.objects;'), '2', 'Losing upload is retained without altering the successful checkpoint');
  console.log('Online projects/workspaces: ownership, grants, validation, rollback, lease fencing, immutable storage, idempotency, concurrent acquisition and CAS checks passed.');
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
} finally {
  if (started) run('pg_ctl', ['-D', data, '-m', 'fast', '-w', 'stop']);
  rmSync(temporary, { recursive: true, force: true });
}
