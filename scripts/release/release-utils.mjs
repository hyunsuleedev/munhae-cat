import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { parse } from 'yaml';

export function feedUrl(value) {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) {
    throw new Error('MUNHAE_UPDATE_URL must be a public HTTPS directory without credentials, query or fragment.');
  }
  if (url.hostname.endsWith('.r2.cloudflarestorage.com') || url.hostname.endsWith('.r2.dev')) {
    throw new Error('Use an R2 custom public domain, not the S3 API or development endpoint.');
  }
  if (!url.pathname.endsWith('/')) url.pathname += '/';
  return url.toString();
}
export function stableVersion(value) {
  if (typeof value !== 'string' || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(value)) {
    throw new Error('Windows stable releases require an x.y.z version.');
  }
  return value;
}
export function newerThan(next, current) {
  const a = stableVersion(next).split('.').map(Number), b = stableVersion(current).split('.').map(Number);
  for (let i = 0; i < 3; i++) { if (a[i] !== b[i]) return a[i] > b[i]; }
  return false;
}
export async function digestFile(path, algorithm = 'sha512', encoding = 'base64') {
  const hash = createHash(algorithm);
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest(encoding);
}
export async function validateRelease(directory, expectedVersion) {
  const version = stableVersion(expectedVersion);
  const metadata = parse(await readFile(join(directory, 'latest.yml'), 'utf8'));
  if (metadata.version !== version || !Array.isArray(metadata.files) || metadata.files.length !== 1) {
    throw new Error('latest.yml must describe exactly this version and one Windows x64 installer.');
  }
  const name = `Munhae-Studio-${version}-x64-setup.exe`;
  const entry = metadata.files[0];
  if (entry.url !== name || basename(entry.url) !== entry.url || metadata.path && metadata.path !== name) {
    throw new Error('Unexpected installer name or path in update metadata.');
  }
  const path = join(directory, name);
  if ((await stat(path)).size !== entry.size || await digestFile(path) !== entry.sha512
    || metadata.sha512 && metadata.sha512 !== entry.sha512) {
    throw new Error('Installer hash/size does not match latest.yml.');
  }
  if ((await stat(join(directory, `${name}.blockmap`))).size === 0) throw new Error('Empty blockmap.');
  return { version, name, metadata, files: [name, `${name}.blockmap`] };
}
/** Upload metadata only after all immutable artifacts are publicly readable and verified. */
export async function publishRelease(release, operations) {
  for (const name of release.files) await operations.uploadArtifact(name);
  for (const name of release.files) await operations.verifyPublic(name);
  await operations.promoteMetadata('latest.yml');
}
