#!/usr/bin/env node
// Disposable PostgreSQL cluster; no linked Supabase project or credentials used.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const temporary = mkdtempSync('/tmp/munhae-billing-tests-');
const data = join(temporary, 'data');
const env = { ...process.env };
for (const key of Object.keys(env)) if (key.startsWith('PG')) delete env[key];
const psqlArgs = ['-X', '-q', '-v', 'ON_ERROR_STOP=1', '-h', temporary, '-p', '55442', '-U', 'postgres', '-d', 'postgres'];
let started = false;
function run(command, args, input) {
  const result = spawnSync(command, args, { encoding: 'utf8', env, input });
  if (result.error || result.status !== 0) throw new Error(`${command} failed: ${result.error?.message || result.stderr || result.stdout}`);
  return result.stdout.trim();
}
function sql(input) { return run('psql', psqlArgs, input); }
function concurrent(input) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn('psql', [...psqlArgs, '-At'], { env });
    let output = '', error = '';
    child.stdout.on('data', (chunk) => { output += chunk; });
    child.stderr.on('data', (chunk) => { error += chunk; });
    child.on('error', reject);
    child.on('exit', (code) => code === 0 ? resolvePromise(output.trim()) : reject(new Error(error)));
    child.stdin.end(input);
  });
}
try {
  run('initdb', ['-D', data, '-U', 'postgres', '-A', 'trust', '--no-instructions', '--locale=C', '--encoding=UTF8']);
  run('pg_ctl', ['-D', data, '-l', join(temporary, 'postgres.log'), '-o', `-F -c listen_addresses='' -k ${temporary} -p 55442`, '-w', 'start']);
  started = true;
  sql(`create role anon; create role authenticated; create role service_role bypassrls;
    create schema auth; create table auth.users (id uuid primary key);
    create function auth.uid() returns uuid language sql stable as
      $$ select (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')::uuid $$;
    grant usage on schema public, auth to anon, authenticated, service_role;
    grant execute on function auth.uid() to anon, authenticated, service_role;
    alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
    alter default privileges in schema public grant execute on functions to anon, authenticated, service_role;`);
  sql(readFileSync(join(root, 'supabase/migrations/20260922222326_stripe_billing.sql'), 'utf8'));
  sql(readFileSync(join(root, 'supabase/migrations/20260922222459_stripe_billing_subscription_index.sql'), 'utf8'));
  sql(readFileSync(join(root, 'supabase/tests/stripe_billing.sql'), 'utf8'));
  assert.equal(run('psql', [...psqlArgs, '-At'], 'select count(*) from public.billing_subscriptions'), '0');
  sql("insert into auth.users values ('00000000-0000-4000-8000-000000000003')");
  const claims = await Promise.all([1, 2, 3, 4].map((number) => concurrent(`
    set role service_role;
    select public.acquire_billing_customer('00000000-0000-4000-8000-000000000003','acct_munhae',false,'00000000-0000-4000-8000-00000000000${number}') is not null;
  `)));
  assert.equal(claims.filter((value) => value === 't').length, 1, 'Exactly one concurrent customer/checkout/webhook operation may own the lease');
  assert.equal(run('psql', [...psqlArgs, '-At'], 'select count(*) from public.billing_customers'), '1');
  console.log('Stripe billing SQL: RLS/grants, user/account/mode isolation, null/stale/concurrent leases, receipt deduplication, projection rollback and entitlement revocation passed.');
} catch (error) {
  console.error(error.message); process.exitCode = 1;
} finally {
  if (started) run('pg_ctl', ['-D', data, '-m', 'fast', '-w', 'stop']);
  rmSync(temporary, { recursive: true, force: true });
}
