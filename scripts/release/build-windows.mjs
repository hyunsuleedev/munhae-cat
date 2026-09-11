import { spawnSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse, stringify } from 'yaml';
import { feedUrl, stableVersion, validateRelease, digestFile } from './release-utils.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const desktop = resolve(root, 'apps/desktop');
const version = stableVersion(JSON.parse(await readFile(resolve(desktop, 'package.json'), 'utf8')).version);
const url = feedUrl(process.env.MUNHAE_UPDATE_URL ?? '');
const config = parse(await readFile(resolve(desktop, 'electron-builder.yml'), 'utf8'));
config.publish = [{ provider: 'generic', url, useMultipleRangeRequest: false }];
config.forceCodeSigning = process.env.MUNHAE_REQUIRE_SIGNING === 'true';
const generated = resolve(desktop, 'release-config.generated.yml');
await writeFile(generated, stringify(config));
if (process.argv.includes('--config-only')) {
  console.log(`Prepared Windows x64 release configuration for ${version}.`);
  process.exit(0);
}
if (process.platform !== 'win32' || process.arch !== 'x64') throw new Error('Build on a Windows x64 runner for native module compatibility.');
function run(args) {
  // pnpm.cmd requires cmd.exe on Windows. Arguments here are fixed or trusted local paths.
  const result = spawnSync('pnpm', args, { cwd: desktop, stdio: 'inherit', shell: true });
  if (result.status !== 0) throw new Error(`Build command failed (${result.status}).`);
}
run(['exec', 'electron-builder', 'install-app-deps', '--arch', 'x64']);
run(['build']);
run(['exec', 'electron-builder', '--win', 'nsis', '--x64', '--config', 'release-config.generated.yml', '--publish', 'never']);
const directory = resolve(desktop, 'release');
const release = await validateRelease(directory, version);
const checksums = await Promise.all([...release.files, 'latest.yml'].map(async name => `${await digestFile(resolve(directory, name), 'sha256', 'hex')}  ${name}`));
await mkdir(directory, { recursive: true });
await writeFile(resolve(directory, 'SHA256SUMS.txt'), checksums.join('\n') + '\n');
console.log(`Verified build artifacts for ${release.version}. Nothing has been published.`);
