#!/usr/bin/env node
// Exercise the real main-process transport with an in-memory Supabase client.
// Does not read credentials, invoke the network, or touch user projects.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const requireDesktop = createRequire(join(root, 'apps/desktop/package.json'));
const ts = requireDesktop('typescript');
const temporary = mkdtempSync('/tmp/munhae-remote-tests-');

try {
  for (const name of ['errors', 'online-projects', 'online-workspace-remote']) {
    const source = readFileSync(join(root, 'apps/desktop/src/main', `${name}.ts`), 'utf8');
    const compiled = ts.transpileModule(source, {
      compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 },
    }).outputText.replace(/from "\.\/(errors|online-projects)"/g, 'from "./$1.mjs"');
    writeFileSync(join(temporary, `${name}.mjs`), compiled);
  }
  const { OnlineWorkspaceRemote, ONLINE_WORKSPACE_MAX_BYTES } = await import(pathToFileURL(join(temporary, 'online-workspace-remote.mjs')).href);
  const owner = '00000000-0000-4000-8000-000000000001';
  const project = '00000000-0000-4000-8000-000000000101';
  const lease = '00000000-0000-4000-8000-000000000201';
  const checkpoint = '00000000-0000-4000-8000-000000000301';
  const objectPath = `${owner}/${project}/1/${checkpoint}.munhaepkg`;
  const bytes = new Uint8Array([80, 75, 3, 4, 5, 6, 7, 8]);
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  let head = {
    project_id: project, owner_id: owner, revision: 0, object_path: null, sha256: null, byte_size: null,
    lease_id: lease, fence: 1, lease_expires_at: '2030-01-01T00:00:00Z', updated_at: '2026-09-22T12:00:00Z',
  };
  let available = false, owns = true, rpcError = null, uploadError = null, releaseResult = true;
  let rpcData, lastRpc, lastUpload, downloadCount = 0, ownerChecks = 0;
  const objects = new Map();
  const client = {
    from(table) {
      const filters = {};
      const query = {
        select() { return query; },
        eq(key, value) { filters[key] = value; return query; },
        async maybeSingle() {
          assert.equal(filters.owner_id, owner);
          if (table === 'online_projects') {
            ownerChecks += 1;
            assert.equal(filters.id, project);
            return { data: owns ? { id: project, owner_id: owner } : null, error: null };
          }
          assert.equal(table, 'online_project_workspaces');
          assert.equal(filters.project_id, project);
          return { data: available ? { ...head } : null, error: null };
        },
      };
      return query;
    },
    rpc(name, input) {
      lastRpc = { name, input };
      const result = { data: name === 'release_online_workspace' ? releaseResult : rpcData ?? { ...head }, error: rpcError };
      return { single: async () => result, then: (success, failure) => Promise.resolve(result).then(success, failure) };
    },
    storage: {
      from(bucket) {
        assert.equal(bucket, 'online-project-workspaces');
        return {
          async upload(path, body, options) {
            lastUpload = { path, body: new Uint8Array(body), options };
            if (uploadError) return { data: null, error: uploadError };
            if (objects.has(path)) return { data: null, error: { message: 'The resource already exists', statusCode: '409' } };
            objects.set(path, new Blob([body]));
            return { data: { path }, error: null };
          },
          async download(path) {
            downloadCount += 1;
            return { data: objects.get(path) ?? null, error: null };
          },
        };
      },
    },
  };
  const remote = new OnlineWorkspaceRemote(async (action) => action(client, owner));
  assert.equal(await remote.get(project), null);
  const acquired = await remote.acquire(project, lease);
  assert.equal(acquired.leaseId, lease);
  assert.equal(lastRpc.name, 'acquire_online_workspace');
  assert.deepEqual(lastRpc.input, { p_project_id: project, p_lease_id: lease });
  available = true;
  assert.equal((await remote.get(project)).revision, 0);
  assert.equal((await remote.renew(project, lease, 1)).fence, 1);
  releaseResult = false;
  await remote.release(project, lease, 1);
  rpcError = { message: 'ONLINE_WORKSPACE_LOCKED', code: 'P0001' };
  await assert.rejects(remote.acquire(project, lease), { code: 'online_workspace_locked' });
  rpcError = { message: 'ONLINE_WORKSPACE_LEASE_LOST', code: 'P0001' };
  await assert.rejects(remote.renew(project, lease, 1), { code: 'online_workspace_lease_lost' });
  rpcError = null;
  rpcData = { ...head, owner_id: '00000000-0000-4000-8000-000000000002' };
  await assert.rejects(remote.acquire(project, lease), { code: 'online_workspace_response_invalid' });
  rpcData = undefined;

  const mutableBytes = new Uint8Array(bytes);
  const uploading = remote.upload(project, lease, 1, checkpoint, mutableBytes);
  mutableBytes[0] = 0;
  assert.equal(await uploading, objectPath);
  assert.deepEqual(lastUpload.body, bytes, 'Upload must capture immutable bytes before awaiting');
  assert.equal(lastUpload.options.upsert, false);
  assert.equal(lastUpload.options.contentType, 'application/zip');
  assert.deepEqual(lastUpload.options.metadata, { lease_id: lease });
  assert.equal(await remote.upload(project, lease, 1, checkpoint, bytes), objectPath, 'An exact repeated upload is idempotent');
  await assert.rejects(remote.upload(project, lease, 1, checkpoint, mutableBytes), { code: 'online_workspace_checkpoint_invalid' });
  uploadError = { message: 'The object exceeded the maximum allowed size', statusCode: '413' };
  await assert.rejects(remote.upload(project, lease, 1, checkpoint, bytes), { code: 'online_workspace_too_large' });
  uploadError = null;

  const input = { projectId: project, leaseId: lease, fence: 1, expectedRevision: 0, objectPath, sha256, byteSize: bytes.length };
  rpcData = { ...head, revision: 1, object_path: objectPath, sha256, byte_size: bytes.length };
  const committed = await remote.commit(input);
  assert.equal(committed.revision, 1);
  assert.equal(lastRpc.input.p_expected_revision, 0);
  assert.deepEqual(await remote.download(committed), bytes);
  const beforeInvalidPath = downloadCount;
  await assert.rejects(remote.download({ ...committed, objectPath: objectPath.replace(owner, '00000000-0000-4000-8000-000000000002') }), { code: 'online_workspace_response_invalid' });
  assert.equal(downloadCount, beforeInvalidPath, 'Cross-owner object paths must not reach Storage');
  objects.set(objectPath, new Blob([new Uint8Array([0, 0, 0, 0, 0, 0, 0, 0])]));
  await assert.rejects(remote.download(committed), { code: 'online_workspace_checkpoint_invalid' });
  assert.throws(() => remote.download({ ...committed, byteSize: ONLINE_WORKSPACE_MAX_BYTES + 1 }), { code: 'online_workspace_too_large' });
  rpcError = { message: 'ONLINE_WORKSPACE_CONFLICT', code: '40001' };
  await assert.rejects(remote.commit(input), { code: 'online_workspace_conflict' });
  rpcError = null;
  owns = false;
  await assert.rejects(remote.get(project), { code: 'online_workspace_forbidden' });
  await assert.rejects(remote.download(committed), { code: 'online_workspace_forbidden' });
  assert.ok(ownerChecks >= 16, 'Every remote operation must check the current owner');
  const failed = new OnlineWorkspaceRemote(async () => { throw new Error('RAW_NETWORK_SECRET_MUST_NOT_ESCAPE'); });
  await assert.rejects(failed.get(project), (error) => error.code === 'online_workspace_request_failed' && !error.message.includes('RAW_NETWORK'));
  console.log('Online workspace transport: owner boundaries, lease errors, immutable retries, upload snapshot, size limits, SHA validation, CAS and sanitized failures passed.');
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
