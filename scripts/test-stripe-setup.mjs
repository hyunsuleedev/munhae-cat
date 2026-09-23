import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const directory = mkdtempSync(join(tmpdir(), 'munhae-stripe-setup-'));
const executable = join(directory, 'stripe');
const log = join(directory, 'calls.jsonl');
const state = join(directory, 'state.json');
writeFileSync(executable, `#!${process.execPath}
const fs = require('node:fs');
const a = process.argv.slice(2); const [method,path] = a;
fs.appendFileSync(process.env.TEST_LOG, JSON.stringify(a)+'\\n');
const data = JSON.parse(fs.readFileSync(process.env.TEST_STATE));
const params = Object.fromEntries(a.flatMap((v,i) => v === '-d' ? [a[i+1].split(/=(.*)/s).slice(0,2)] : []));
let r;
if (path === '/v1/account') r = {id:'acct_expected',charges_enabled:process.env.TEST_DISABLED !== 'true'};
else if (path === '/v1/balance') r = {livemode:process.env.TEST_LIVE === 'true'};
else if (method === 'get') r = {data: data[path] || []};
else {
 r = {id:path === '/v1/products' ? params.id : path.includes('configurations') ? 'bpc_test' : 'price_test',active:true,livemode:a.includes('--live'),
 metadata:{application:'munhae'},product:params.product,currency:params.currency,unit_amount:Number(params.unit_amount),
 tax_behavior:params.tax_behavior,recurring:{interval:'month',interval_count:1},
 features:{subscription_cancel:{enabled:true,mode:'at_period_end'},invoice_history:{enabled:true},payment_method_update:{enabled:true},subscription_update:{enabled:false}}};
 data[path] = [r]; fs.writeFileSync(process.env.TEST_STATE,JSON.stringify(data));
}
console.log(JSON.stringify(r));
`, { mode: 0o700 });
function run(args = [], extra = {}) {
  const env = { ...process.env, PATH: `${directory}:${process.env.PATH}`, TEST_LOG: log, TEST_STATE: state, ...extra };
  if (!Object.hasOwn(extra, 'STRIPE_API_KEY')) delete env.STRIPE_API_KEY;
  return spawnSync(process.execPath, [resolve('scripts/setup-stripe-billing.mjs'), '--account', 'acct_expected', ...args], { env, encoding: 'utf8' });
}
function calls() { return readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse); }
function reset() { writeFileSync(log, ''); writeFileSync(state, '{}'); }
try {
  reset();
  assert.equal(run().status, 0);
  assert(calls().every(call => call[0] === 'get'), 'Default invocation must be read-only');
  reset();
  assert.notEqual(run(['--account', 'acct_wrong', '--apply']).status, 0);
  assert(calls().every(call => call[0] === 'get'), 'Account mismatch must never mutate');
  reset();
  assert.notEqual(run(['--apply'], { TEST_LIVE: 'true' }).status, 0);
  assert(calls().every(call => call[0] === 'get'), 'Live credentials must fail before writes');
  reset();
  assert.notEqual(run(['--apply'], { STRIPE_API_KEY: 'test-redacted' }).status, 0);
  assert.equal(calls().length, 0, 'Ambient API key must not override selected profile');
  reset();
  const created = run(['--apply']);
  assert.equal(created.status, 0, created.stderr);
  assert.equal(calls().filter(call => call[0] === 'post').length, 3);
  const retry = run(['--apply']);
  assert.equal(retry.status, 0, retry.stderr);
  assert.equal(calls().filter(call => call[0] === 'post').length, 3, 'Setup retry must reuse existing resources');
  const changed = JSON.parse(readFileSync(state));
  changed['/v1/prices'][0].unit_amount = 20000;
  writeFileSync(state, JSON.stringify(changed));
  assert.notEqual(run(['--apply']).status, 0, 'Unexpected existing price must fail');
  assert.equal(calls().filter(call => call[0] === 'post').length, 3);
  reset();
  assert.equal(run(['--live']).status, 1, 'Live flag must reject a test-mode response');
  assert(calls().every(call => call[0] === 'get'));
  reset();
  assert.notEqual(run(['--live', '--apply'], {TEST_LIVE:'true', TEST_DISABLED:'true'}).status, 0);
  assert(calls().every(call => call[0] === 'get'), 'Disabled live account must not mutate');
  reset();
  const live = run(['--live', '--apply'], {TEST_LIVE:'true'});
  assert.equal(live.status, 0, live.stderr);
  assert(calls().every(call => call.includes('--live')), 'Every live request must explicitly select live mode');
  assert.equal(calls().filter(call => call[0] === 'post').length, 3);
  assert.equal(run(['--live', '--apply'], {TEST_LIVE:'true'}).status, 0);
  assert.equal(calls().filter(call => call[0] === 'post').length, 3, 'Live retry reuses resources');
  console.log('Stripe setup: 9 safety/idempotency checks passed (fake CLI, no remote writes).');
} finally { rmSync(directory, { recursive: true, force: true }); }
