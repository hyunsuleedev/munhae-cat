import { S3Client, GetObjectCommand, HeadObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { parse } from 'yaml';
import { feedUrl, validateRelease, digestFile, newerThan, publishRelease } from './release-utils.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const directory = resolve(root, 'apps/desktop/release');
const version = JSON.parse(await readFile(resolve(root, 'apps/desktop/package.json'), 'utf8')).version;
const release = await validateRelease(directory, version);
const base = feedUrl(process.env.MUNHAE_UPDATE_URL ?? '');
const config = parse(await readFile(resolve(root, 'apps/desktop/release-config.generated.yml'), 'utf8'));
if (config.publish?.[0]?.url !== base) throw new Error('Build and publish feed URLs differ.');
if (!process.argv.includes('--publish')) {
  console.log(JSON.stringify({ mode: 'dry-run', version, files: [...release.files, 'latest.yml'], destination: base }, null, 2));
  process.exit(0);
}
if (process.platform !== 'win32') throw new Error('Publish on Windows after verifying Authenticode.');
const signature = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
  '$s = Get-AuthenticodeSignature -LiteralPath $env:MUNHAE_INSTALLER; if ($s.Status -ne "Valid") { throw "Installer signature is not valid" }'],
  { env: { ...process.env, MUNHAE_INSTALLER: resolve(directory, release.name) }, stdio: 'inherit' });
if (signature.status !== 0) throw new Error('Refusing to publish an unsigned or invalid installer.');
const required = name => { const value = process.env[name]; if (!value) throw new Error(`Missing ${name}`); return value; };
const account = required('R2_ACCOUNT_ID');
if (!/^[a-f0-9]{32}$/i.test(account)) throw new Error('Invalid R2 account ID.');
const bucket = required('R2_BUCKET');
const prefix = required('R2_PREFIX').replace(/\/$/, '');
if (!/^[a-zA-Z0-9/_-]+$/.test(prefix) || prefix.startsWith('/')) throw new Error('Invalid R2_PREFIX.');
const client = new S3Client({ region: 'auto', endpoint: `https://${account}.r2.cloudflarestorage.com`,
  credentials: { accessKeyId: required('R2_ACCESS_KEY_ID'), secretAccessKey: required('R2_SECRET_ACCESS_KEY') },
  requestChecksumCalculation: 'WHEN_REQUIRED', responseChecksumValidation: 'WHEN_REQUIRED' });
async function request(name) {
  return fetch(new URL(name, base), { cache: 'no-store', signal: AbortSignal.timeout(120_000) });
}
let previousEtag;
try {
  const previous = await client.send(new GetObjectCommand({ Bucket: bucket, Key: `${prefix}/latest.yml` }));
  const current = parse(await previous.Body.transformToString());
  if (!newerThan(version, current.version)) throw new Error('Release must be newer than the published version.');
  previousEtag = previous.ETag;
  if (!previousEtag) throw new Error('Missing current metadata ETag.');
} catch (error) { if (error.$metadata?.httpStatusCode !== 404) throw error; }
await publishRelease(release, {
  async uploadArtifact(name) {
    const file = resolve(directory, name);
    const digest = await digestFile(file, 'sha256', 'hex');
    try {
      const existing = await client.send(new HeadObjectCommand({ Bucket: bucket, Key: `${prefix}/${name}` }));
      if (existing.Metadata?.sha256 !== digest) throw new Error(`Refusing to replace existing artifact: ${name}`);
      return;
    } catch (error) { if (error.$metadata?.httpStatusCode !== 404) throw error; }
    await client.send(new PutObjectCommand({ Bucket: bucket, Key: `${prefix}/${name}`, Body: createReadStream(file),
      ContentLength: (await stat(file)).size, ContentType: 'application/octet-stream',
      CacheControl: 'public, max-age=31536000, immutable', Metadata: { sha256: digest }, IfNoneMatch: '*' }));
  },
  async verifyPublic(name) {
    const response = await request(name);
    if (!response.ok || !response.body) throw new Error(`Public artifact unavailable: ${name} HTTP ${response.status}`);
    const hash = createHash('sha256');
    for await (const chunk of response.body) hash.update(chunk);
    if (hash.digest('hex') !== await digestFile(resolve(directory, name), 'sha256', 'hex')) throw new Error(`Public hash mismatch: ${name}`);
  },
  async promoteMetadata(name) {
    const body = await readFile(resolve(directory, name));
    await client.send(new PutObjectCommand({ Bucket: bucket, Key: `${prefix}/${name}`, Body: body,
      ContentType: 'application/yaml', CacheControl: 'no-cache, no-store, must-revalidate',
      ...(previousEtag ? { IfMatch: previousEtag } : { IfNoneMatch: '*' }) }));
    const response = await request(name);
    if (!response.ok || await response.text() !== body.toString('utf8')) throw new Error('Metadata uploaded but public feed is stale; inspect cache rules.');
  },
});
console.log(`Published and verified Windows x64 ${version}.`);
