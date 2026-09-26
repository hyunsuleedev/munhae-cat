#!/usr/bin/env node
// Upserts supabase/plugin-catalog into the linked project's plugin_catalog table.
// Usage: node scripts/sync-plugin-catalog.mjs [--dry-run]
// The secret key comes from SUPABASE_SECRET_KEY or the Supabase CLI at run time and is never printed.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseTranslationSkill } from '../packages/db-sqlite/src/translation-skill.ts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dir = join(root, 'supabase/plugin-catalog');
const { plugins } = JSON.parse(readFileSync(join(dir, 'catalog.json'), 'utf8'));

// The same checks the app applies, so an invalid row never reaches the catalog.
const rows = plugins.map(({ name, published }, index) => {
  const skill = parseTranslationSkill(readFileSync(join(dir, name, 'SKILL.md'), 'utf8'));
  if (skill.name !== name) throw new Error(`${name}/SKILL.md declares name "${skill.name}"`);
  if (typeof published !== 'boolean') throw new Error(`${name}: published must be true or false`);
  console.log(`${published ? 'published' : 'draft    '}  ${name}@${skill.version ?? '-'}`);
  return { name, content: skill.content, sort_order: (index + 1) * 10, published };
});
if (process.argv.includes('--dry-run')) process.exit(0);

const ref = process.env.SUPABASE_PROJECT_REF ?? readFileSync(join(root, 'supabase/.temp/project-ref'), 'utf8').trim();
function cliServiceKey() {
  const keys = JSON.parse(execFileSync('supabase', ['projects', 'api-keys', '--project-ref', ref, '-o', 'json'],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] }));
  // The CLI masks new-style secret keys; the legacy service_role JWT is returned whole.
  const usable = (key) => typeof key?.api_key === 'string' && /^[\w.-]+$/.test(key.api_key);
  return [keys.find((key) => key.type === 'secret'), keys.find((key) => key.name === 'service_role')].find(usable)?.api_key;
}
const secret = process.env.SUPABASE_SECRET_KEY ?? cliServiceKey();
if (!secret) throw new Error('No Supabase service key is available for this project.');
const auth = { apikey: secret, ...(secret.startsWith('eyJ') ? { Authorization: `Bearer ${secret}` } : {}) };

const endpoint = `https://${ref}.supabase.co/rest/v1/plugin_catalog`;
const upsert = await fetch(`${endpoint}?on_conflict=name`, {
  method: 'POST',
  headers: { ...auth, 'Content-Type': 'application/json', Prefer: 'resolution=merge-duplicates,return=minimal' },
  body: JSON.stringify(rows),
});
if (!upsert.ok) throw new Error(`Upload failed (${upsert.status}): ${await upsert.text()}`);

const remote = await (await fetch(`${endpoint}?select=name,published&order=sort_order`, { headers: auth })).json();
const extra = remote.filter((row) => !rows.some((local) => local.name === row.name));
if (extra.length) console.warn(`Left unchanged (not in catalog.json): ${extra.map((row) => row.name).join(', ')}`);
console.log(`Synced ${rows.length} plugins to ${ref}: ${remote.filter((row) => row.published).length} published.`);
