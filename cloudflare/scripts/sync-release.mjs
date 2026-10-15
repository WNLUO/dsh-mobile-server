// Syncs tagged stable Relay releases into a user's Deploy-button copy.
import { spawnSync } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';

const VERSION_FILE = '.dsh-relay-upstream-version';
const WRANGLER_BASE_DIR = '.dsh-relay-upstream';
const WRANGLER_FILE = 'wrangler.toml';

export function parseStableVersion(value) {
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(value);
  if (!match) throw new Error(`Expected a stable x.y.z version, got: ${value}`);
  return match.slice(1).map(Number);
}

export function compareStableVersions(left, right) {
  const a = parseStableVersion(left);
  const b = parseStableVersion(right);
  for (let index = 0; index < a.length; index += 1) {
    if (a[index] !== b[index]) return a[index] < b[index] ? -1 : 1;
  }
  return 0;
}

export function validateReleaseVersion({ version, packageVersion, baselineVersion, releasedVersions = [] }) {
  parseStableVersion(version);
  if (packageVersion !== version) {
    throw new Error(`Release version ${version} does not match cloudflare/package.json (${packageVersion})`);
  }
  if (baselineVersion !== version) {
    throw new Error(`Release version ${version} does not match cloudflare/.dsh-relay-upstream-version (${baselineVersion})`);
  }
  const latest = releasedVersions.map((candidate) => {
    parseStableVersion(candidate);
    return candidate;
  }).sort(compareStableVersions).at(-1);
  if (latest && compareStableVersions(version, latest) <= 0) {
    throw new Error(`Version ${version} must be newer than cloudflare-v${latest}`);
  }
}

function isLocalOnly(relativePath) {
  const parts = relativePath.split(sep);
  const name = basename(relativePath);
  if (parts.some((part) => part === '.git' || part === '.wrangler' || part === 'node_modules')) return true;
  if (name === WRANGLER_FILE || relativePath === VERSION_FILE || parts[0] === WRANGLER_BASE_DIR) return true;
  if (name === '.dev.vars' || (name.startsWith('.dev.vars.') && name !== '.dev.vars.example')) return true;
  if (name === '.env' || (name.startsWith('.env.') && name !== '.env.example')) return true;
  return false;
}

async function mergeWranglerConfig(targetDir, sourceDir) {
  const currentPath = join(targetDir, WRANGLER_FILE);
  const basePath = join(targetDir, WRANGLER_BASE_DIR, WRANGLER_FILE);
  const nextPath = join(sourceDir, WRANGLER_FILE);
  const [current, base, next] = await Promise.all([
    readFile(currentPath, 'utf8'),
    readFile(basePath, 'utf8'),
    readFile(nextPath, 'utf8'),
  ]);
  const tempDir = await mkdtemp(join(tmpdir(), 'dsh-relay-wrangler-'));
  try {
    const paths = ['current.toml', 'base.toml', 'next.toml'].map((name) => join(tempDir, name));
    await Promise.all(paths.map((path, index) => writeFile(path, [current, base, next][index])));
    const result = spawnSync('git', ['merge-file', '--diff3', '-p', ...paths], { encoding: 'utf8' });
    if (result.error) throw result.error;
    if (result.status === 1) {
      throw new Error('wrangler.toml has overlapping user and upstream changes; no update was applied. Resolve the config conflict, then run the update again.');
    }
    if (result.status !== 0) {
      throw new Error(`git merge-file failed: ${(result.stderr || '').trim() || `exit ${result.status}`}`);
    }
    return result.stdout;
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

async function copyUpstreamFiles(sourceDir, targetDir, current = '') {
  const entries = await readdir(sourceDir, { withFileTypes: true });
  for (const entry of entries) {
    const sourcePath = join(sourceDir, entry.name);
    const relativePath = current ? join(current, entry.name) : entry.name;
    if (isLocalOnly(relativePath)) continue;
    const targetPath = join(targetDir, relativePath);
    if (entry.isDirectory()) {
      await mkdir(targetPath, { recursive: true });
      await copyUpstreamFiles(sourcePath, targetDir, relativePath);
    } else if (entry.isFile()) {
      await mkdir(dirname(targetPath), { recursive: true });
      await cp(sourcePath, targetPath);
    }
  }
}

export async function syncRelease({ sourceDir, targetDir, version }) {
  parseStableVersion(version);
  const sourcePackage = JSON.parse(await readFile(join(sourceDir, 'package.json'), 'utf8'));
  if (sourcePackage.version !== version) {
    throw new Error(`Release version ${version} does not match upstream package version ${sourcePackage.version}`);
  }
  const currentVersion = (await readFile(join(targetDir, VERSION_FILE), 'utf8')).trim();
  parseStableVersion(currentVersion);
  if (compareStableVersions(version, currentVersion) <= 0) {
    return { updated: false, currentVersion, version };
  }

  const nextBasePath = join(sourceDir, WRANGLER_BASE_DIR, WRANGLER_FILE);
  const nextBase = await readFile(nextBasePath, 'utf8');
  const nextConfig = await readFile(join(sourceDir, WRANGLER_FILE), 'utf8');
  if (nextBase !== nextConfig) {
    throw new Error('Upstream wrangler.toml and its merge base differ; refusing an unsafe update.');
  }
  const mergedConfig = await mergeWranglerConfig(targetDir, sourceDir);

  await copyUpstreamFiles(sourceDir, targetDir);
  await writeFile(join(targetDir, WRANGLER_FILE), mergedConfig);
  await mkdir(join(targetDir, WRANGLER_BASE_DIR), { recursive: true });
  await writeFile(join(targetDir, WRANGLER_BASE_DIR, WRANGLER_FILE), nextBase);
  await writeFile(join(targetDir, VERSION_FILE), `${version}\n`);
  return { updated: true, currentVersion, version };
}

function parseArgs(args) {
  const options = {};
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index];
    if (!['--source', '--target', '--version'].includes(key) || !args[index + 1]) {
      throw new Error('Usage: node scripts/sync-release.mjs --source <release-cloudflare-dir> --target <deployment-repo-root> --version <x.y.z>');
    }
    options[key.slice(2)] = args[index + 1];
  }
  if (!options.source || !options.target || !options.version) {
    throw new Error('Usage: node scripts/sync-release.mjs --source <release-cloudflare-dir> --target <deployment-repo-root> --version <x.y.z>');
  }
  return options;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const options = parseArgs(process.argv.slice(2));
    const result = await syncRelease({ sourceDir: options.source, targetDir: options.target, version: options.version });
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
