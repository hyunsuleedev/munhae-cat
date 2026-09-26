#!/usr/bin/env node
// Disposable PostgreSQL cluster; no linked Supabase project or credentials used.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const temporary = mkdtempSync('/tmp/munhae-plugin-catalog-tests-');
const data = join(temporary, 'data');
const env = { ...process.env };
for (const key of Object.keys(env)) if (key.startsWith('PG')) delete env[key];
const psqlArgs = ['-X', '-q', '-v', 'ON_ERROR_STOP=1', '-h', temporary, '-p', '55443', '-U', 'postgres', '-d', 'postgres'];
let started = false;
function run(command, args, input) {
  const result = spawnSync(command, args, { encoding: 'utf8', env, input });
  if (result.error || result.status !== 0) throw new Error(`${command} failed: ${result.error?.message || result.stderr || result.stdout}`);
  return result.stdout.trim();
}
function sql(input) { return run('psql', psqlArgs, input); }
try {
  run('initdb', ['-D', data, '-U', 'postgres', '-A', 'trust', '--no-instructions', '--locale=C', '--encoding=UTF8']);
  run('pg_ctl', ['-D', data, '-l', join(temporary, 'postgres.log'), '-o', `-F -c listen_addresses='' -k ${temporary} -p 55443`, '-w', 'start']);
  started = true;
  sql(`create role anon; create role authenticated; create role service_role bypassrls;
    create schema auth;
    create function auth.uid() returns uuid language sql stable as
      $$ select (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')::uuid $$;
    grant usage on schema public, auth to anon, authenticated, service_role;
    alter default privileges in schema public grant all on tables to anon, authenticated, service_role;`);
  sql(readFileSync(join(root, 'supabase/migrations/20260926130000_plugin_catalog.sql'), 'utf8'));
  sql(readFileSync(join(root, 'supabase/tests/plugin_catalog.sql'), 'utf8'));
  console.log('Plugin catalog SQL: read-only grants, published-row RLS and name checks passed.');
} catch (error) {
  console.error(error.message); process.exitCode = 1;
} finally {
  if (started) run('pg_ctl', ['-D', data, '-m', 'fast', '-w', 'stop']);
  rmSync(temporary, { recursive: true, force: true });
}
