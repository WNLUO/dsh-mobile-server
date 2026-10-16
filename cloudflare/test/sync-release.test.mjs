// Covers stable release validation, config merging, and private local file preservation.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { compareStableVersions, syncRelease, validateReleaseVersion } from '../scripts/sync-release.mjs';

const initialConfig = `name = "dsh-mobile-relay"
main = "src/index.mjs"
compatibility_date = "2026-10-15"
workers_dev = true

[[durable_objects.bindings]]
name = "RELAY"
class_name = "RelayInstance"

[[migrations]]
tag = "v1"
new_sqlite_classes = ["RelayInstance"]

[vars]
`;

async function makeFixture(t, { currentVersion = '0.1.0', releaseVersion = '0.2.0', targetConfig = initialConfig, releaseConfig = initialConfig.replace('workers_dev = true', 'workers_dev = true\nsend_metrics = false'), baseConfig = initialConfig } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-relay-update-test-'));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const sourceDir = join(root, 'release', 'cloudflare');
  const targetDir = join(root, 'deployment');
  await mkdir(join(sourceDir, '.dsh-relay-upstream'), { recursive: true });
  await mkdir(join(sourceDir, '.github', 'workflows'), { recursive: true });
  await writeFile(join(sourceDir, '.github', 'workflows', 'release.yml'), 'canonical release workflow\n');
  await mkdir(join(sourceDir, 'src'), { recursive: true });
  await mkdir(join(targetDir, '.dsh-relay-upstream'), { recursive: true });
  await mkdir(join(targetDir, 'src'), { recursive: true });
  await writeFile(join(sourceDir, 'package.json'), JSON.stringify({ name: 'dsh-mobile-relay-cloudflare', version: releaseVersion }));
  await writeFile(join(sourceDir, 'wrangler.toml'), releaseConfig);
  await writeFile(join(sourceDir, '.dsh-relay-upstream', 'wrangler.toml'), releaseConfig);
  await writeFile(join(sourceDir, '.dev.vars.example'), `RELAY_SECRET=example-for-${releaseVersion}\n`);
  await writeFile(join(sourceDir, 'src', 'index.mjs'), `export const version = '${releaseVersion}';\n`);
  await writeFile(join(targetDir, '.dsh-relay-upstream-version'), `${currentVersion}\n`);
  await writeFile(join(targetDir, '.dsh-relay-upstream', 'wrangler.toml'), baseConfig);
  await writeFile(join(targetDir, 'wrangler.toml'), targetConfig);
  await writeFile(join(targetDir, '.dev.vars'), 'RELAY_SECRET=private-user-secret\n');
  await writeFile(join(targetDir, '.env'), 'PRIVATE_ENV=do-not-copy\n');
  await writeFile(join(targetDir, '.env.local'), 'PRIVATE_LOCAL=do-not-copy\n');
  await mkdir(join(targetDir, '.wrangler'), { recursive: true });
  await writeFile(join(targetDir, '.wrangler', 'state.v3'), 'local-state\n');
  await writeFile(join(sourceDir, '.env.example'), 'PUBLIC_ENV=example-only\n');
  await mkdir(join(sourceDir, '.wrangler'), { recursive: true });
  await writeFile(join(sourceDir, '.wrangler', 'state.v3'), 'upstream-state\n');
  await writeFile(join(targetDir, 'src', 'index.mjs'), `export const version = '${currentVersion}';\n`);
  return { sourceDir, targetDir };
}

test('compares stable versions numerically', () => {
  assert.equal(compareStableVersions('0.10.0', '0.9.9'), 1);
  assert.equal(compareStableVersions('1.0.0', '1.0.0'), 0);
  assert.equal(compareStableVersions('0.2.0', '0.3.0'), -1);
});

test('requires a stable release to match its package and deployment baseline and advance tags', () => {
  assert.doesNotThrow(() => validateReleaseVersion({
    version: '0.2.0', packageVersion: '0.2.0', baselineVersion: '0.2.0', releasedVersions: ['0.1.0'],
  }));
  assert.doesNotThrow(() => validateReleaseVersion({
    version: '0.1.0', packageVersion: '0.1.0', baselineVersion: '0.1.0', releasedVersions: [],
  }));
  assert.throws(() => validateReleaseVersion({
    version: '0.1.0', packageVersion: '0.1.0', baselineVersion: '0.1.0', releasedVersions: ['0.1.0'],
  }), /must be newer than cloudflare-v0.1.0/);
  assert.throws(() => validateReleaseVersion({
    version: '0.2.0', packageVersion: '0.1.0', baselineVersion: '0.2.0', releasedVersions: [],
  }), /does not match package\.json/);
  assert.throws(() => validateReleaseVersion({
    version: '0.2.0', packageVersion: '0.2.0', baselineVersion: '0.1.0', releasedVersions: [],
  }), /does not match \.dsh-relay-upstream-version/);
  assert.throws(() => validateReleaseVersion({
    version: '1.0.0-rc.1', packageVersion: '1.0.0-rc.1', baselineVersion: '1.0.0-rc.1', releasedVersions: [],
  }), /Expected a stable x\.y\.z version/);
});

test('updates package files while preserving user Wrangler settings and local secrets', async (t) => {
  const targetConfig = initialConfig.replace('name = "dsh-mobile-relay"', 'name = "my-private-relay"').replace('[vars]\n', '[vars]\nSTAGE = "private"\n');
  const { sourceDir, targetDir } = await makeFixture(t, { targetConfig });
  const result = await syncRelease({ sourceDir, targetDir, version: '0.2.0' });
  assert.deepEqual(result, { updated: true, currentVersion: '0.1.0', version: '0.2.0' });
  const config = await readFile(join(targetDir, 'wrangler.toml'), 'utf8');
  assert.match(config, /name = "my-private-relay"/);
  assert.match(config, /STAGE = "private"/);
  assert.match(config, /send_metrics = false/);
  assert.equal(await readFile(join(targetDir, '.dsh-relay-upstream-version'), 'utf8'), '0.2.0\n');
  assert.equal(await readFile(join(targetDir, 'src', 'index.mjs'), 'utf8'), "export const version = '0.2.0';\n");
  assert.equal(await readFile(join(targetDir, '.dev.vars'), 'utf8'), 'RELAY_SECRET=private-user-secret\n');
  assert.equal(await readFile(join(targetDir, '.env'), 'utf8'), 'PRIVATE_ENV=do-not-copy\n');
  assert.equal(await readFile(join(targetDir, '.env.local'), 'utf8'), 'PRIVATE_LOCAL=do-not-copy\n');
  assert.equal(await readFile(join(targetDir, '.wrangler', 'state.v3'), 'utf8'), 'local-state\n');
  assert.equal(await readFile(join(targetDir, '.dev.vars.example'), 'utf8'), 'RELAY_SECRET=example-for-0.2.0\n');
  assert.equal(await readFile(join(targetDir, '.env.example'), 'utf8'), 'PUBLIC_ENV=example-only\n');
  assert.equal(await readFile(join(targetDir, '.dsh-relay-upstream', 'wrangler.toml'), 'utf8'), await readFile(join(sourceDir, 'wrangler.toml'), 'utf8'));
  await assert.rejects(readFile(join(targetDir, '.github', 'workflows', 'release.yml')), { code: 'ENOENT' });
});

test('does not change deployment files when the release conflicts with user Wrangler edits', async (t) => {
  const targetConfig = initialConfig.replace('name = "dsh-mobile-relay"', 'name = "my-private-relay"');
  const releaseConfig = initialConfig.replace('name = "dsh-mobile-relay"', 'name = "upstream-renamed-relay"');
  const { sourceDir, targetDir } = await makeFixture(t, { targetConfig, releaseConfig });
  await assert.rejects(syncRelease({ sourceDir, targetDir, version: '0.2.0' }), /wrangler\.toml has overlapping user and upstream changes/);
  assert.equal(await readFile(join(targetDir, 'wrangler.toml'), 'utf8'), targetConfig);
  assert.equal(await readFile(join(targetDir, '.dsh-relay-upstream-version'), 'utf8'), '0.1.0\n');
  assert.equal(await readFile(join(targetDir, 'src', 'index.mjs'), 'utf8'), "export const version = '0.1.0';\n");
});

test('skips an already-applied version and rejects a tag/package mismatch', async (t) => {
  const { sourceDir, targetDir } = await makeFixture(t, { currentVersion: '0.2.0', releaseVersion: '0.2.0' });
  const result = await syncRelease({ sourceDir, targetDir, version: '0.2.0' });
  assert.equal(result.updated, false);
  assert.equal(await readFile(join(targetDir, 'src', 'index.mjs'), 'utf8'), "export const version = '0.2.0';\n");
  await assert.rejects(syncRelease({ sourceDir, targetDir, version: '0.3.0' }), /does not match upstream package version/);
});
