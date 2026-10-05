import { spawnSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { parse, stringify } from 'yaml';
import { digestFile } from './release-utils.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const desktop = resolve(root, 'apps/desktop');
const args = process.argv.slice(2);
const resumePattern = /^--resume-app-job=([a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12})$/i;
if (args.some(arg => !['--check', '--arm64', '--x64'].includes(arg) && !resumePattern.test(arg))) {
  throw new Error('Usage: pnpm dist:mac:signed [--check] [--arm64 | --x64] [--resume-app-job=UUID]');
}
const resumeJob = args.find(arg => resumePattern.test(arg))?.match(resumePattern)[1];
if (args.includes('--arm64') && args.includes('--x64')) throw new Error('Build one architecture at a time.');
if (process.platform !== 'darwin') throw new Error('Run signed macOS builds on a Mac.');
const arch = args.includes('--arm64') ? 'arm64' : args.includes('--x64') ? 'x64' : process.arch;
if (!['arm64', 'x64'].includes(arch)) throw new Error('Supported architectures: arm64, x64.');

// This path uses the login keychain, never exported certificates or plaintext passwords.
const env = { ...process.env };
for (const name of ['CSC_LINK', 'CSC_KEY_PASSWORD', 'CSC_NAME', 'APPLE_ID',
  'APPLE_APP_SPECIFIC_PASSWORD', 'APPLE_API_KEY', 'APPLE_API_KEY_ID', 'APPLE_API_ISSUER']) delete env[name];
env.APPLE_KEYCHAIN_PROFILE ||= 'munhae-notary';
env.CSC_IDENTITY_AUTO_DISCOVERY = 'true';
function run(command, commandArgs, capture = false) {
  const result = spawnSync(command, commandArgs, {
    cwd: desktop, env, encoding: 'utf8', stdio: capture ? 'pipe' : 'inherit',
  });
  if (result.error || result.status !== 0) {
    // Keychain-based commands contain no plaintext credentials. Retain diagnostics.
    if (capture && result.stderr) console.error(result.stderr.trim());
    throw new Error(`${command} failed. ${capture ? 'Check the certificate/keychain profile and try again.' : 'See output above.'}`);
  }
  return result.stdout ?? '';
}
const identities = [...run('security', ['find-identity', '-v', '-p', 'codesigning'], true)
  .matchAll(/\b([A-F0-9]{40})\s+"(Developer ID Application: [^"\n]+)"/g)]
  .map(match => ({ hash: match[1], name: match[2] }));
const requested = process.env.MUNHAE_MAC_SIGNING_IDENTITY;
const selected = requested ? identities.filter(identity => identity.hash === requested || identity.name === requested) : identities;
if (selected.length !== 1) {
  throw new Error(identities.length === 0
    ? 'No valid Developer ID Application identity with private key. Create/install it in Xcode first.'
    : 'Set MUNHAE_MAC_SIGNING_IDENTITY to the full certificate name or SHA-1 of one valid Developer ID Application identity.');
}
const identity = selected[0];
const team = identity.name.match(/\(([A-Z0-9]{10})\)$/)?.[1];
if (!team) throw new Error('Cannot read Team ID from the signing certificate.');
if (env.APPLE_TEAM_ID && env.APPLE_TEAM_ID !== team) throw new Error('APPLE_TEAM_ID does not match the signing certificate.');
run('xcrun', ['--find', 'notarytool'], true);
const keychainArgs = ['--keychain-profile', env.APPLE_KEYCHAIN_PROFILE];
if (env.APPLE_KEYCHAIN) keychainArgs.push('--keychain', env.APPLE_KEYCHAIN);
run('xcrun', ['notarytool', 'history', ...keychainArgs, '--output-format', 'json'], true);
console.log(`Signing identity: ${identity.name}. Notary credentials verified.`);
if (args.includes('--check')) process.exit(0);

const config = parse(await readFile(resolve(desktop, 'electron-builder.yml'), 'utf8'));
const metadata = JSON.parse(await readFile(resolve(desktop, 'package.json'), 'utf8'));
config.publish = null;
config.forceCodeSigning = true;
config.directories.output = 'release/mac-signed';
Object.assign(config.mac, {
  // electron-builder rejects the certificate type prefix; SHA-1 selects the exact identity.
  identity: identity.hash,
  type: 'distribution',
  hardenedRuntime: true,
  notarize: !resumeJob,
  entitlements: 'build/entitlements.mac.release.plist',
  entitlementsInherit: 'build/entitlements.mac.release.plist',
  // Chromium data packs are sealed by the bundle signature, not executable code.
  signIgnore: ['\\.pak$'],
});
const generated = resolve(desktop, 'release-macos-config.generated.yml');
await writeFile(generated, stringify(config));
const directory = resolve(desktop, config.directories.output);
const app = resolve(directory, arch === 'arm64' ? 'mac-arm64' : 'mac', `${config.productName}.app`);
if (resumeJob) {
  run('codesign', ['--verify', '--deep', '--strict', app]);
  const appVersion = run('plutil', ['-extract', 'CFBundleShortVersionString', 'raw', '-o', '-',
    resolve(app, 'Contents/Info.plist')], true).trim();
  if (appVersion !== metadata.version) throw new Error('Existing app version does not match package.json.');
  const info = JSON.parse(run('xcrun', ['notarytool', 'info', resumeJob,
    ...keychainArgs, '--output-format', 'json'], true));
  if (info.name !== `${config.productName}.zip`) throw new Error('Submission does not describe this application archive.');
  await writeFile(resolve(directory, `notarization-app-${arch}.json`), JSON.stringify(info, null, 2) + '\n');
  console.log(`Waiting for existing Apple app notarization: ${resumeJob}. No new app submission.`);
  const result = JSON.parse(run('xcrun', ['notarytool', 'wait', resumeJob,
    ...keychainArgs, '--output-format', 'json'], true));
  await writeFile(resolve(directory, `notarization-app-${arch}.json`), JSON.stringify(result, null, 2) + '\n');
  if (result.status !== 'Accepted') throw new Error(`App notarization was not accepted: ${result.status}. Inspect submission ${resumeJob}.`);
  run('xcrun', ['stapler', 'staple', app]);
  run('pnpm', ['exec', 'electron-builder', '--mac', 'dmg', 'zip', `--${arch}`,
    '--prepackaged', app, '--config', generated, '--publish', 'never']);
} else {
  run('pnpm', ['build']);
  run('pnpm', ['exec', 'electron-builder', '--mac', 'dmg', 'zip', `--${arch}`,
    '--config', generated, '--publish', 'never']);
}

run('codesign', ['--verify', '--deep', '--strict', '--verbose=2', app]);
const details = spawnSync('codesign', ['--display', '--verbose=4', app], { encoding: 'utf8' });
if (details.status !== 0 || !details.stderr.includes(`TeamIdentifier=${team}`)
  || !details.stderr.includes('Authority=Developer ID Application:') || !/flags=.*\bruntime\b/.test(details.stderr)) {
  throw new Error('Packaged app is missing the expected Developer ID / Team ID / Hardened Runtime.');
}
run('xcrun', ['stapler', 'validate', app]);
run('spctl', ['--assess', '--type', 'execute', '--verbose=2', app]);
const dmg = `${config.productName}-${metadata.version}-${arch}.dmg`;
const zip = `${config.productName}-${metadata.version}-${arch}.zip`;
// The final disk image needs its own submission before its ticket can be stapled.
const upload = JSON.parse(run('xcrun', ['notarytool', 'submit', resolve(directory, dmg),
  ...keychainArgs, '--output-format', 'json'], true));
await writeFile(resolve(directory, `notarization-dmg-${arch}.json`), JSON.stringify(upload, null, 2) + '\n');
console.log(`Waiting for Apple DMG notarization: ${upload.id}`);
const submission = JSON.parse(run('xcrun', ['notarytool', 'wait', upload.id,
  ...keychainArgs, '--output-format', 'json'], true));
await writeFile(resolve(directory, `notarization-dmg-${arch}.json`), JSON.stringify(submission, null, 2) + '\n');
if (submission.status !== 'Accepted') {
  throw new Error(`DMG notarization was not accepted (submission ${submission.id ?? 'unknown'}). Inspect its notarytool log.`);
}
run('xcrun', ['stapler', 'staple', resolve(directory, dmg)]);
run('xcrun', ['stapler', 'validate', resolve(directory, dmg)]);
run('hdiutil', ['verify', resolve(directory, dmg)]);
// Stapling changes the image bytes after electron-builder creates its blockmap.
const desktopRequire = createRequire(resolve(desktop, 'package.json'));
const builderRequire = createRequire(desktopRequire.resolve('electron-builder/package.json'));
const { buildBlockMap } = builderRequire('app-builder-lib/out/targets/blockmap/blockmap');
await buildBlockMap(resolve(directory, dmg), 'gzip', resolve(directory, `${dmg}.blockmap`));
const sums = await Promise.all([dmg, zip].map(async name =>
  `${await digestFile(resolve(directory, name), 'sha256', 'hex')}  ${name}`));
await writeFile(resolve(directory, `SHA256SUMS-${arch}.txt`), sums.join('\n') + '\n');
console.log(`Verified signed and notarized ${arch} artifacts: ${directory}`);
