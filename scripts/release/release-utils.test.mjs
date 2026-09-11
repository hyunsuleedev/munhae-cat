import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { stringify } from 'yaml';
import { feedUrl, newerThan, validateRelease, publishRelease } from './release-utils.mjs';

test('release feed only permits HTTPS without embedded credentials', () => {
  assert.equal(feedUrl('https://downloads.example.org/windows/x64'), 'https://downloads.example.org/windows/x64/');
  for (const url of ['http://example.org', 'https://key:secret@example.org', 'https://example.org/?token=secret', 'https://a.r2.dev', 'https://a.r2.cloudflarestorage.com']) {
    assert.throws(() => feedUrl(url));
  }
});
test('stable publication rejects downgrade, repeats and prereleases', () => {
  assert.equal(newerThan('0.10.0', '0.9.9'), true);
  assert.equal(newerThan('0.9.0', '0.10.0'), false);
  assert.equal(newerThan('1.0.0', '1.0.0'), false);
  assert.throws(() => newerThan('1.0.1-beta', '1.0.0'));
});
test('validates real artifact hashes, sizes and safe metadata paths', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'munhae-release-'));
  try {
    const data = Buffer.from('test fixture, not executable');
    const name = 'Munhae-Studio-0.1.0-x64-setup.exe';
    const metadata = { version: '0.1.0', files: [{ url: name, sha512: createHash('sha512').update(data).digest('base64'), size: data.length }] };
    await writeFile(join(dir, name), data);
    await writeFile(join(dir, `${name}.blockmap`), 'map');
    await writeFile(join(dir, 'latest.yml'), stringify(metadata));
    assert.equal((await validateRelease(dir, '0.1.0')).name, name);
    await writeFile(join(dir, name), 'corrupt');
    await assert.rejects(validateRelease(dir, '0.1.0'), /hash\/size/);
    metadata.files[0].url = '../outside.exe';
    await writeFile(join(dir, 'latest.yml'), stringify(metadata));
    await assert.rejects(validateRelease(dir, '0.1.0'), /name or path/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
test('promotes metadata only after every uploaded file is verified publicly', async () => {
  const calls = [];
  await publishRelease({ files: ['app.exe', 'app.exe.blockmap'] }, {
    uploadArtifact: async n => calls.push(`upload ${n}`), verifyPublic: async n => calls.push(`verify ${n}`),
    promoteMetadata: async n => calls.push(`promote ${n}`),
  });
  assert.deepEqual(calls, ['upload app.exe', 'upload app.exe.blockmap', 'verify app.exe', 'verify app.exe.blockmap', 'promote latest.yml']);
});
test('failed upload or public verification never advertises the release', async () => {
  for (const step of ['uploadArtifact', 'verifyPublic']) {
    let promoted = false;
    const operations = { uploadArtifact: async () => {}, verifyPublic: async () => {}, promoteMetadata: async () => { promoted = true; } };
    operations[step] = async () => { throw new Error('network failed'); };
    await assert.rejects(publishRelease({ files: ['app.exe'] }, operations));
    assert.equal(promoted, false);
  }
});
