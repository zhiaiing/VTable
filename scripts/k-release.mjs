import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const SCRIPT_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));

export const RUNTIME_VERSIONS = Object.freeze({
  '@visactor/vrender': '1.1.7',
  '@visactor/vrender-core': '1.1.7',
  '@visactor/vrender-kits': '1.1.7',
  '@visactor/vrender-components': '1.1.7',
  '@visactor/vrender-animate': '1.1.7'
});

const COMMANDS = new Set(['prepare', 'pack', 'publish', 'stages', 'stage-approve']);
const RELEASE_PACKAGES = Object.freeze(['k-vtable', 'k-react-vtable']);
const PUBLISH_PACKAGES = RELEASE_PACKAGES;
const STAGE_CONFLICT_CODE = 'E409';
const PUBLISH_ATTEMPTS = 2;
// 见 https://docs.npmjs.com/staged-publishing：staged publish 的 CLI/Node 最低版本。
const STAGED_PUBLISHING = Object.freeze({ npm: '11.15.0', node: '22.14.0' });
const ENVIRONMENT_ERROR_CODES = Object.freeze(['EPERM', 'EACCES', 'EROFS', 'ENOSPC', 'EEXIST']);
const SEMVER_PATTERN =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;

export function parseCliArgs(argv) {
  const [command, ...rest] = argv;
  if (!COMMANDS.has(command)) {
    throw new Error(`Unknown command "${command ?? ''}"; expected ${[...COMMANDS].join(', ')}`);
  }

  const result = {
    command,
    version: undefined,
    registry: undefined,
    tag: undefined,
    otp: undefined,
    stageId: undefined,
    package: undefined,
    stage: false,
    approve: false,
    skipBuild: false
  };

  for (let index = 0; index < rest.length; index++) {
    const argument = rest[index];
    if (argument === '--skip-build') {
      result.skipBuild = true;
      continue;
    }
    if (argument === '--stage') {
      result.stage = true;
      continue;
    }
    if (argument === '--approve') {
      result.approve = true;
      continue;
    }

    if (
      argument === '--version' ||
      argument === '--registry' ||
      argument === '--tag' ||
      argument === '--otp' ||
      argument === '--stage-id' ||
      argument === '--package'
    ) {
      const value = rest[index + 1];
      if (!value || value.startsWith('--')) {
        throw new Error(`${argument} requires a value`);
      }
      result[argument.slice(2).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())] = value;
      index++;
      continue;
    }

    throw new Error(`Unknown argument "${argument}"`);
  }

  if (command === 'stages') {
    if (result.version || result.tag || result.package || result.stage || result.approve) {
      throw new Error('stages accepts only --registry, --otp and --stage-id');
    }
    return result;
  }

  if (!result.version || !SEMVER_PATTERN.test(result.version)) {
    throw new Error('--version must be a valid semver version');
  }
  if (result.skipBuild && command !== 'prepare') {
    throw new Error('--skip-build is only supported by prepare');
  }
  if (command === 'stage-approve') {
    if (!result.stageId) {
      throw new Error('stage-approve requires --stage-id');
    }
    if (result.stage || result.approve) {
      throw new Error('stage-approve does not accept --stage or --approve');
    }
    return result;
  }
  if (result.stageId) {
    throw new Error(`--stage-id is not supported by ${command}`);
  }
  if (result.stage && command !== 'publish') {
    throw new Error('--stage is only supported by publish');
  }
  if (result.approve && !result.stage) {
    throw new Error('--approve requires --stage; approval is deferred 2FA by design');
  }
  if (command === 'publish' && !result.tag) {
    throw new Error('publish requires --tag');
  }
  if (command === 'publish' && !result.package) {
    throw new Error(`publish requires --package (${PUBLISH_PACKAGES.join(' or ')})`);
  }
  if (result.package && !PUBLISH_PACKAGES.includes(result.package)) {
    throw new Error(`--package must be one of ${PUBLISH_PACKAGES.join(', ')}`);
  }
  if (result.package && command !== 'publish') {
    throw new Error(`--package is not supported by ${command}; it selects a single publishable package`);
  }
  if (command === 'stage-approve' && !result.stageId) {
    throw new Error('stage-approve requires --stage-id');
  }
  if (command !== 'stage-approve' && command !== 'stages' && command !== 'publish' && result.otp) {
    throw new Error(`--otp is not supported by ${command}`);
  }

  return result;
}

function cloneManifest(manifest) {
  return JSON.parse(JSON.stringify(manifest));
}

function removeDevelopmentFields(manifest) {
  delete manifest.scripts;
  delete manifest.devDependencies;
  delete manifest.rushVersion;
  delete manifest.versionPolicyName;
  return manifest;
}

export function buildVtableManifest(sourceManifest, releaseVersion) {
  const manifest = removeDevelopmentFields(cloneManifest(sourceManifest));
  const editorVersion = manifest.dependencies?.['@visactor/vtable-editors'];
  if (typeof editorVersion !== 'string') {
    throw new Error('Missing @visactor/vtable-editors dependency');
  }

  manifest.name = 'k-vtable';
  manifest.version = releaseVersion;
  manifest.sideEffects = true;
  manifest.main = 'cjs/index.js';
  manifest.module = 'es/index.js';
  manifest.types = 'es/index.d.ts';
  manifest.files = ['cjs', 'es'];
  manifest.publishConfig = { access: 'public' };
  manifest.dependencies = {
    ...manifest.dependencies,
    '@visactor/vtable-editors': editorVersion.replace(/^workspace:/, '')
  };

  return manifest;
}

export function buildReactManifest(sourceManifest, releaseVersion) {
  const manifest = removeDevelopmentFields(cloneManifest(sourceManifest));
  const dependencies = { ...(manifest.dependencies ?? {}) };
  delete dependencies['@visactor/vtable'];
  delete manifest.exports;

  manifest.name = 'k-react-vtable';
  manifest.version = releaseVersion;
  manifest.sideEffects = true;
  manifest.main = 'cjs/index.js';
  manifest.module = 'es/index.js';
  manifest.types = 'es/index.d.ts';
  manifest.files = ['cjs', 'es'];
  manifest.dependencies = dependencies;
  manifest.peerDependencies = {
    ...(manifest.peerDependencies ?? {}),
    'k-vtable': releaseVersion,
    react: '^18.2.0 || ^19.0.0',
    'react-dom': '^18.2.0 || ^19.0.0'
  };
  manifest.publishConfig = { access: 'public' };

  return manifest;
}

export function replaceVtableReferences(source, options = {}) {
  const format = options.format === 'cjs' ? 'cjs' : 'es';
  return source
    .replace(/@visactor\/vtable\/es\//g, `k-vtable/${format}/`)
    .replace(/@visactor\/vtable(?=\/|['"`]|$)/g, 'k-vtable');
}

export function rewriteEntryVersion(source, expectedVersion, releaseVersion) {
  const occurrences = source.split(expectedVersion).length - 1;
  if (occurrences === 0) {
    throw new Error(`Expected version "${expectedVersion}" was not found`);
  }
  if (occurrences !== 1) {
    throw new Error(`Expected version "${expectedVersion}" must occur exactly once; found ${occurrences}`);
  }
  return source.replace(expectedVersion, releaseVersion);
}

export function assertSafeGeneratedPath(repoRoot, targetPath) {
  const root = path.resolve(repoRoot);
  const target = path.resolve(targetPath);
  const relative = path.relative(root, target);
  const segments = relative.split(path.sep);

  if (
    relative.startsWith('..') ||
    path.isAbsolute(relative) ||
    segments.length !== 2 ||
    !['release', 'artifacts'].includes(segments[0]) ||
    !segments[1]
  ) {
    throw new Error(`Unsafe generated path: ${target}`);
  }

  return target;
}

export function validatePackFileList(packResult) {
  if (!packResult || !Array.isArray(packResult.files)) {
    throw new Error('npm pack result does not contain a files array');
  }

  const allowedTopLevel = new Set(['package.json', 'README.md', 'LICENSE', 'es', 'cjs']);
  for (const file of packResult.files) {
    const filePath = file?.path;
    if (typeof filePath !== 'string' || !filePath) {
      throw new Error('npm pack returned an invalid file path');
    }
    const normalized = filePath.replaceAll('\\', '/');
    const topLevel = normalized.split('/')[0];
    if (!allowedTopLevel.has(topLevel)) {
      throw new Error(`Unexpected npm pack file: ${normalized}`);
    }
    if (/(^|\/)(dist|src|node_modules|test|tests|__tests__|\.bundle)(\/|$)/.test(normalized)) {
      throw new Error(`Forbidden npm pack file: ${normalized}`);
    }
    if (/(^|\/)(pnpm-lock\.yaml|package-lock\.json|yarn\.lock)$/.test(normalized)) {
      throw new Error(`Forbidden npm pack lockfile: ${normalized}`);
    }
  }
}

async function pathExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return false;
    }
    throw error;
  }
}

async function readJson(filePath) {
  return JSON.parse(await fs.readFile(filePath, 'utf8'));
}

async function writeJson(filePath, value) {
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

export function runProcess(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      stdio: options.inherit ? 'inherit' : ['ignore', 'pipe', 'pipe']
    });
    let stdout = '';
    let stderr = '';
    if (!options.inherit) {
      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      child.stdout.on('data', chunk => {
        stdout += chunk;
      });
      child.stderr.on('data', chunk => {
        stderr += chunk;
      });
    }
    child.on('error', error => {
      reject(error);
    });
    child.on('close', code => {
      if (code !== 0) {
        const rendered = [command, ...args].join(' ');
        const details = [stdout.trim(), stderr.trim()].filter(Boolean).join('\n');
        const error = new Error(`Command failed (${code}): ${rendered}${details ? `\n${details}` : ''}`);
        error.command = rendered;
        error.exitCode = code;
        error.stdout = stdout;
        error.stderr = stderr;
        error.npmErrorCode = parseNpmErrorCode(`${details}\n${error.message}`);
        reject(error);
        return;
      }
      resolve({ stdout, stderr, code });
    });
  });
}

export function parseNpmErrorCode(text) {
  if (typeof text !== 'string' || !text) {
    return undefined;
  }
  const match = text.match(/\bcode\s+E[A-Z0-9]{2,12}\b/);
  return match ? match[0].replace(/^code\s+/, '') : undefined;
}

export function isEnvironmentErrorCode(code) {
  return typeof code === 'string' && ENVIRONMENT_ERROR_CODES.includes(code ? code.toUpperCase() : code);
}

export function isStageConflictError(error) {
  const code = error?.npmErrorCode ?? parseNpmErrorCode(error?.message ?? '');
  if (code !== STAGE_CONFLICT_CODE) {
    return false;
  }
  return /previously staged version/i.test(error?.message ?? '');
}

function compareVersions(left, right) {
  const leftParts = String(left).split('.').map(Number);
  const rightParts = String(right).split('.').map(Number);
  for (let index = 0; index < Math.max(leftParts.length, rightParts.length); index++) {
    const a = leftParts[index] ?? 0;
    const b = rightParts[index] ?? 0;
    if (a !== b) {
      return a < b ? -1 : 1;
    }
  }
  return 0;
}

export function assertStagedPublishingSupport(npmVersion, nodeVersion = process.versions.node) {
  if (!npmVersion || compareVersions(npmVersion, STAGED_PUBLISHING.npm) < 0) {
    throw new Error(
      `staged publish 需要 npm ${STAGED_PUBLISHING.npm} 或更高版本（当前 ${npmVersion ?? 'unknown'}）；` +
        '请先升级 npm。'
    );
  }
  if (!nodeVersion || compareVersions(nodeVersion, STAGED_PUBLISHING.node) < 0) {
    throw new Error(
      `staged publish 需要 Node ${STAGED_PUBLISHING.node} 或更高版本` +
        `（当前 ${nodeVersion ?? 'unknown'}）；请先升级 Node。`
    );
  }
}

async function readNpmVersion(execute) {
  const result = await execute('npm', ['--version'], {});
  return typeof result.stdout === 'string' ? result.stdout.trim() : '';
}

async function queryStagedVersions(execute, packageNames, registry) {
  let result;
  try {
    result = await execute('npm', ['stage', 'list', ...packageNames, '--json', ...registryArgs(registry)], {});
  } catch (error) {
    throw withCommandContext(error, 'npm stage list 失败');
  }
  let parsed;
  try {
    parsed = JSON.parse(typeof result.stdout === 'string' && result.stdout.trim() ? result.stdout : '[]');
  } catch (error) {
    throw new Error(`npm stage list returned unparsable JSON: ${error.message}`);
  }
  if (!Array.isArray(parsed)) {
    throw new Error('npm stage list did not return an array');
  }
  return parsed.map(item => ({
    id: item?.id,
    name: item?.packageName ?? item?.name,
    version: item?.version,
    tag: item?.tag,
    createdAt: item?.createdAt,
    actor: item?.actor,
    shasum: item?.shasum
  }));
}

export function findStagedVersions(stagedItems, packageName, version) {
  return (stagedItems ?? []).filter(
    item => item?.name === packageName && (version === undefined || item?.version === version)
  );
}

export function formatStageConflictHelp({ packageName, version, stagedItems = [] }) {
  const matching = findStagedVersions(stagedItems, packageName, version);
  const lines = [
    `${packageName}@${version} 无法发布：registry 的暂存区已存在完全相同的版本。`,
    '',
    'npm 的暂存区与正式版本共用同一个 semver 唯一索引：同一版本一旦被 staged，',
    '只有 approve（发布）或 reject（丢弃）之后才能再次发布；',
    '而暂存版本在 npm view 中不可见，所以发布脚本会一直看不到它。请先处理这份暂存：'
  ];

  if (matching.length) {
    for (const item of matching) {
      const details = [item.createdAt, item.actor].filter(Boolean).join(' / ');
      lines.push(`  - stage-id ${item.id ?? '<unknown>'}${details ? ` (${details})` : ''}`);
    }
    lines.push('');
    if (matching.length === 1 && matching[0].id) {
      lines.push(`  # 确认就是本次构建（建议先 npm stage download ${matching[0].id} 核对）：`);
      lines.push(
        `  node scripts/k-release.mjs stage-approve --stage-id ${matching[0].id} --version ${version}`
      );
      lines.push('  # 或丢弃暂存后重新发布（该版本不会出现在正式版本列表中）：');
      lines.push(`  npm stage reject ${matching[0].id}`);
    } else {
      lines.push('  # 逐个确认后批准：');
      lines.push(`  node scripts/k-release.mjs stage-approve --stage-id <stage-id> --version ${version}`);
      lines.push('  # 或丢弃暂存后重新发布：');
      lines.push('  npm stage reject <stage-id>');
    }
  } else if (stagedItems.length) {
    lines.push('  已找到其他暂存版本，请核对是否属于本次发布：');
    for (const item of stagedItems) {
      const details = [item.name, item.version, item.id].filter(Boolean).join(' / ');
      lines.push(`  - ${details}`);
    }
  } else {
    lines.push(`  当前 registry 没有列出暂存版本；请先在登录该 registry 的终端执行：`);
    lines.push(`  npm stage list ${packageName}`);
    lines.push('  确认该版本是否由其它机器或流水线暂存，再决定 approve 还是 reject。');
  }

  lines.push('');
  lines.push(
    '批准前请核对 stage 条目的 shasum/integrity 与本地 tarball 一致，' +
      '避免发布非本次构建的内容。'
  );
  return lines.join('\n');
}

async function listFilesRecursively(root) {
  const files = [];
  const entries = await fs.readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    const entryPath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await listFilesRecursively(entryPath)));
    } else if (entry.isFile()) {
      files.push(entryPath);
    }
  }
  return files;
}

async function requireFiles(filePaths) {
  const missing = [];
  for (const filePath of filePaths) {
    if (!(await pathExists(filePath))) {
      missing.push(filePath);
    }
  }
  if (missing.length) {
    throw new Error(`Missing build output:\n${missing.join('\n')}`);
  }
}

async function rewriteFile(filePath, transform) {
  const source = await fs.readFile(filePath, 'utf8');
  const output = transform(source);
  if (output !== source) {
    await fs.writeFile(filePath, output);
  }
}

function assertRegistryDependencies(manifest) {
  for (const dependencyGroup of ['dependencies', 'peerDependencies', 'optionalDependencies']) {
    for (const [name, version] of Object.entries(manifest[dependencyGroup] ?? {})) {
      if (/^(workspace:|file:|link:)/.test(version)) {
        throw new Error(`${manifest.name} contains non-registry dependency ${name}@${version}`);
      }
    }
  }
}

async function validatePreparedPackage(packageRoot, manifest, expectedName, releaseVersion) {
  if (manifest.name !== expectedName || manifest.version !== releaseVersion) {
    throw new Error(`Generated manifest mismatch for ${expectedName}`);
  }
  assertRegistryDependencies(manifest);
  await requireFiles(
    ['main', 'module', 'types'].map(field => path.join(packageRoot, manifest[field]))
  );

  const topLevel = await fs.readdir(packageRoot);
  const allowed = new Set(['package.json', 'README.md', 'LICENSE', 'es', 'cjs']);
  for (const name of topLevel) {
    if (!allowed.has(name)) {
      throw new Error(`Unexpected generated package entry: ${name}`);
    }
  }
  for (const forbidden of ['dist', 'src', 'node_modules', '.bundle', 'pnpm-lock.yaml', 'package-lock.json']) {
    if (await pathExists(path.join(packageRoot, forbidden))) {
      throw new Error(`Generated package contains forbidden entry: ${forbidden}`);
    }
  }
}

async function defaultGetGitCommit(repoRoot) {
  return (await runProcess('git', ['rev-parse', 'HEAD'], { cwd: repoRoot })).stdout.trim();
}

export async function prepareRelease(options, dependencies = {}) {
  const { version, skipBuild = false } = options;
  if (!version || !SEMVER_PATTERN.test(version)) {
    throw new Error('prepare requires a valid semver version');
  }

  const repoRoot = path.resolve(dependencies.repoRoot ?? path.resolve(SCRIPT_DIRECTORY, '..'));
  const execute = dependencies.runProcess ?? runProcess;
  const getGitCommit = dependencies.getGitCommit ?? defaultGetGitCommit;
  const vtableSource = path.join(repoRoot, 'packages', 'vtable');
  const reactSource = path.join(repoRoot, 'packages', 'react-vtable');
  const vtableRelease = assertSafeGeneratedPath(repoRoot, path.join(repoRoot, 'release', 'k-vtable'));
  const reactRelease = assertSafeGeneratedPath(repoRoot, path.join(repoRoot, 'release', 'k-react-vtable'));
  const artifactsRoot = path.join(repoRoot, 'artifacts');

  await requireFiles([
    path.join(repoRoot, 'rush.json'),
    path.join(repoRoot, 'LICENSE'),
    path.join(vtableSource, 'package.json'),
    path.join(reactSource, 'package.json')
  ]);

  if (!skipBuild) {
    await execute(
      process.execPath,
      [path.join(repoRoot, 'common', 'scripts', 'install-run-rush.js'), 'build', '-t', '@visactor/react-vtable'],
      { cwd: repoRoot, inherit: true }
    );
  }

  await requireFiles(
    [vtableSource, reactSource].flatMap(packageRoot => [
      path.join(packageRoot, 'es', 'index.js'),
      path.join(packageRoot, 'es', 'index.d.ts'),
      path.join(packageRoot, 'cjs', 'index.js')
    ])
  );

  const [vtableSourceManifest, reactSourceManifest, sourceCommit] = await Promise.all([
    readJson(path.join(vtableSource, 'package.json')),
    readJson(path.join(reactSource, 'package.json')),
    getGitCommit(repoRoot)
  ]);

  await fs.mkdir(path.dirname(vtableRelease), { recursive: true });
  await fs.mkdir(artifactsRoot, { recursive: true });
  await Promise.all([
    fs.rm(vtableRelease, { recursive: true, force: true }),
    fs.rm(reactRelease, { recursive: true, force: true })
  ]);
  await Promise.all([fs.mkdir(vtableRelease, { recursive: true }), fs.mkdir(reactRelease, { recursive: true })]);

  for (const [sourceRoot, releaseRoot] of [
    [vtableSource, vtableRelease],
    [reactSource, reactRelease]
  ]) {
    await fs.cp(path.join(sourceRoot, 'es'), path.join(releaseRoot, 'es'), { recursive: true });
    await fs.cp(path.join(sourceRoot, 'cjs'), path.join(releaseRoot, 'cjs'), { recursive: true });
    await fs.copyFile(path.join(sourceRoot, 'README.md'), path.join(releaseRoot, 'README.md'));
    await fs.copyFile(path.join(repoRoot, 'LICENSE'), path.join(releaseRoot, 'LICENSE'));
  }

  const vtableManifest = buildVtableManifest(vtableSourceManifest, version);
  const reactManifest = buildReactManifest(reactSourceManifest, version);
  await Promise.all([
    writeJson(path.join(vtableRelease, 'package.json'), vtableManifest),
    writeJson(path.join(reactRelease, 'package.json'), reactManifest)
  ]);

  const reactFiles = await listFilesRecursively(reactRelease);
  const rewriteExtensions = ['.js', '.d.ts', '.js.map'];
  for (const filePath of reactFiles) {
    if (rewriteExtensions.some(extension => filePath.endsWith(extension))) {
      const isCjsRuntime =
        filePath.startsWith(`${path.join(reactRelease, 'cjs')}${path.sep}`) &&
        (filePath.endsWith('.js') || filePath.endsWith('.js.map'));
      await rewriteFile(filePath, source =>
        replaceVtableReferences(source, { format: isCjsRuntime ? 'cjs' : 'es' })
      );
    }
  }

  for (const [releaseRoot, upstreamVersion] of [
    [vtableRelease, vtableSourceManifest.version],
    [reactRelease, reactSourceManifest.version]
  ]) {
    for (const relativePath of ['es/index.js', 'cjs/index.js', 'es/index.js.map', 'cjs/index.js.map']) {
      const filePath = path.join(releaseRoot, relativePath);
      if (await pathExists(filePath)) {
        await rewriteFile(filePath, source => rewriteEntryVersion(source, upstreamVersion, version));
      }
    }
  }

  await Promise.all([
    validatePreparedPackage(vtableRelease, vtableManifest, 'k-vtable', version),
    validatePreparedPackage(reactRelease, reactManifest, 'k-react-vtable', version)
  ]);

  for (const filePath of await listFilesRecursively(reactRelease)) {
    if (!rewriteExtensions.some(extension => filePath.endsWith(extension))) {
      continue;
    }
    const content = await fs.readFile(filePath, 'utf8');
    if (/@visactor\/vtable(?=\/|['"`]|$)/.test(content)) {
      throw new Error(`Upstream VTable reference remains in ${path.relative(reactRelease, filePath)}`);
    }
    if (filePath.endsWith('.js') && content.includes('CanvasFactory is not configured')) {
      throw new Error(`React output appears to contain bundled VTable core: ${path.relative(reactRelease, filePath)}`);
    }
  }

  const state = {
    version,
    sourceCommit,
    preparedAt: new Date().toISOString(),
    packages: {
      'k-vtable': vtableRelease,
      'k-react-vtable': reactRelease
    }
  };
  const statePath = assertSafeGeneratedPath(
    repoRoot,
    path.join(artifactsRoot, `k-release-${version}.prepare.json`)
  );
  await writeJson(statePath, state);
  return state;
}

function parseNpmPackResult(stdout, label) {
  let parsed;
  try {
    parsed = JSON.parse(stdout);
  } catch (error) {
    throw new Error(`Unable to parse npm pack JSON for ${label}: ${error.message}`);
  }
  const result = Array.isArray(parsed) ? parsed[0] : parsed;
  if (!result || typeof result !== 'object') {
    throw new Error(`npm pack returned no result for ${label}`);
  }
  return result;
}

export async function packRelease(options, dependencies = {}) {
  const { version } = options;
  if (!version || !SEMVER_PATTERN.test(version)) {
    throw new Error('pack requires a valid semver version');
  }

  const repoRoot = path.resolve(dependencies.repoRoot ?? path.resolve(SCRIPT_DIRECTORY, '..'));
  const execute = dependencies.runProcess ?? runProcess;
  const getGitCommit = dependencies.getGitCommit ?? defaultGetGitCommit;
  const runConsumerTests = dependencies.runConsumerTests ?? runCleanConsumerTests;

  const artifactsRoot = path.join(repoRoot, 'artifacts');
  const prepareStatePath = assertSafeGeneratedPath(
    repoRoot,
    path.join(artifactsRoot, `k-release-${version}.prepare.json`)
  );
  if (!(await pathExists(prepareStatePath))) {
    throw new Error(`Missing prepare state for ${version}; run prepare first`);
  }
  const prepareState = await readJson(prepareStatePath);
  const sourceCommit = await getGitCommit(repoRoot);
  if (prepareState.version !== version || prepareState.sourceCommit !== sourceCommit) {
    throw new Error('Prepare state does not match the requested version and current source commit');
  }

  const packageRoots = {
    'k-vtable': path.join(repoRoot, 'release', 'k-vtable'),
    'k-react-vtable': path.join(repoRoot, 'release', 'k-react-vtable')
  };
  await requireFiles(Object.values(packageRoots).map(packageRoot => path.join(packageRoot, 'package.json')));

  for (const [packageName, packageRoot] of Object.entries(packageRoots)) {
    const dryRun = await execute('npm', ['pack', '--dry-run', '--json'], { cwd: packageRoot });
    validatePackFileList(parseNpmPackResult(dryRun.stdout, packageName));
  }

  await fs.mkdir(artifactsRoot, { recursive: true });
  const tarballs = {};
  for (const [packageName, packageRoot] of Object.entries(packageRoots)) {
    const packed = await execute('npm', ['pack', '--json', '--pack-destination', artifactsRoot], { cwd: packageRoot });
    const result = parseNpmPackResult(packed.stdout, packageName);
    validatePackFileList(result);
    if (!result.filename || !result.integrity || !result.shasum) {
      throw new Error(`npm pack metadata is incomplete for ${packageName}`);
    }
    const tarballPath = assertSafeGeneratedPath(repoRoot, path.join(artifactsRoot, path.basename(result.filename)));
    await requireFiles([tarballPath]);
    tarballs[packageName] = {
      filename: path.basename(result.filename),
      path: tarballPath,
      integrity: result.integrity,
      shasum: result.shasum
    };
  }

  await runConsumerTests({ repoRoot, version, tarballs, runProcess: execute });

  const state = {
    version,
    sourceCommit,
    packedAt: new Date().toISOString(),
    testsPassed: true,
    tarballs
  };
  const statePath = assertSafeGeneratedPath(repoRoot, path.join(artifactsRoot, `k-release-${version}.pack.json`));
  await writeJson(statePath, state);
  return state;
}

export function collectPackageVersions(tree, packageNames) {
  const requested = new Set(packageNames);
  const result = new Map(packageNames.map(name => [name, new Set()]));
  const visited = new Set();

  function visit(node) {
    if (!node || typeof node !== 'object' || visited.has(node)) {
      return;
    }
    visited.add(node);
    if (requested.has(node.name) && typeof node.version === 'string') {
      result.get(node.name).add(node.version);
    }
    for (const groupName of ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies']) {
      const group = node[groupName];
      if (!group || typeof group !== 'object') {
        continue;
      }
      for (const [name, dependency] of Object.entries(group)) {
        if (requested.has(name) && typeof dependency?.version === 'string') {
          result.get(name).add(dependency.version);
        }
        visit(dependency);
      }
    }
  }

  for (const root of Array.isArray(tree) ? tree : [tree]) {
    visit(root);
  }
  return result;
}

export async function createConsumerProject({ projectRoot, version, tarballs }) {
  await fs.mkdir(path.join(projectRoot, 'src'), { recursive: true });
  const manifest = {
    name: 'k-vtable-release-consumer',
    version: '0.0.0',
    private: true,
    type: 'module',
    dependencies: {
      'k-vtable': `file:${tarballs['k-vtable'].path}`,
      'k-react-vtable': `file:${tarballs['k-react-vtable'].path}`,
      '@visactor/vchart': '2.1.3',
      react: '18.2.0',
      'react-dom': '18.2.0'
    },
    devDependencies: {
      '@types/react': '18.2.79',
      '@types/react-dom': '18.2.25',
      typescript: '5.2.2',
      vite: '3.2.6'
    }
  };
  await writeJson(path.join(projectRoot, 'package.json'), manifest);
  await writeJson(path.join(projectRoot, 'tsconfig.json'), {
    compilerOptions: {
      target: 'ES2020',
      module: 'ESNext',
      moduleResolution: 'Bundler',
      lib: ['ES2020', 'DOM'],
      jsx: 'react-jsx',
      strict: true,
      noEmit: true,
      skipLibCheck: true
    },
    include: ['type-probe.ts']
  });
  await fs.writeFile(
    path.join(projectRoot, 'type-probe.ts'),
    [
      "import type { ComponentProps } from 'react';",
      "import type { IGroup } from 'k-vtable/es/vrender';",
      "import type { BaseTableAPI, ListTableConstructorOptions } from 'k-vtable/es/ts-types';",
      "import { ListTable } from 'k-react-vtable';",
      'type ListTableProps = ComponentProps<typeof ListTable>;',
      'declare const group: IGroup;',
      'declare const table: BaseTableAPI;',
      'declare const options: ListTableConstructorOptions;',
      'declare const props: ListTableProps;',
      'void group; void table; void options; void props;'
    ].join('\n') + '\n'
  );
  await fs.writeFile(
    path.join(projectRoot, 'cjs-probe.cjs'),
    [
      "const assert = require('node:assert/strict');",
      "const core = require('k-vtable');",
      "const react = require('k-react-vtable');",
      `assert.equal(core.version, ${JSON.stringify(version)});`,
      `assert.equal(react.version, ${JSON.stringify(version)});`
    ].join('\n') + '\n'
  );
  await fs.writeFile(
    path.join(projectRoot, 'esm-probe.mjs'),
    [
      "import assert from 'node:assert/strict';",
      "import * as core from 'k-vtable';",
      "import * as react from 'k-react-vtable';",
      `assert.equal(core.version, ${JSON.stringify(version)});`,
      `assert.equal(react.version, ${JSON.stringify(version)});`
    ].join('\n') + '\n'
  );
  await fs.writeFile(path.join(projectRoot, 'vite.config.js'), "export default { base: './', build: { sourcemap: true } };\n");
  await fs.writeFile(
    path.join(projectRoot, 'index.html'),
    '<!doctype html><html data-test-status="running"><head><meta charset="UTF-8"></head><body><div id="status">running</div><div id="plain"></div><div id="react"></div><div id="pivot"></div><script type="module" src="/src/main.js"></script></body></html>\n'
  );
  await fs.writeFile(
    path.join(projectRoot, 'src', 'main.js'),
    `import React from 'react';
import { createRoot } from 'react-dom/client';
import VChart from '@visactor/vchart';
import * as VTable from 'k-vtable';
import * as ReactVTable from 'k-react-vtable';

const status = document.getElementById('status');
let failed = false;
function fail(error) {
  failed = true;
  const message = error?.stack || error?.message || String(error);
  document.documentElement.dataset.testStatus = 'failed';
  status.textContent = message;
}
window.addEventListener('error', event => fail(event.error || event.message));
window.addEventListener('unhandledrejection', event => fail(event.reason));

async function run() {
  if (VTable.version !== ${JSON.stringify(version)} || ReactVTable.version !== ${JSON.stringify(version)}) {
    throw new Error('Runtime version mismatch');
  }
  const plainContainer = document.getElementById('plain');
  plainContainer.style.cssText = 'width:600px;height:320px';
  const columns = [{ field: 'name', title: 'Name' }, { field: 'value', title: 'Value' }];
  const records = [{ name: 'A', value: 1 }, { name: 'B', value: 2 }, { name: 'C', value: 3 }];
  const table = new VTable.ListTable(plainContainer, { columns, records, frozenRowCount: 2 });
  if (table.frozenRowCount !== 2) throw new Error('Frozen row verification failed');
  table.release();

  let customLayoutCalls = 0;
  const reactContainer = document.getElementById('react');
  reactContainer.style.cssText = 'width:600px;height:320px';
  const root = createRoot(reactContainer);
  root.render(
    React.createElement(
      ReactVTable.ListTable,
      { records, height: 300 },
      React.createElement(ReactVTable.ListColumn, { field: 'name', title: 'Name' }),
      React.createElement(ReactVTable.ListColumn, {
        field: 'value',
        title: 'Value',
        customLayout: () => {
          customLayoutCalls++;
          return { rootContainer: new VTable.Group({}), renderDefault: true };
        }
      })
    )
  );
  await new Promise(resolve => setTimeout(resolve, 800));
  if (customLayoutCalls === 0) throw new Error('React customLayout was not invoked');
  root.unmount();

  VTable.register.chartModule('vchart', VChart);
  const pivotContainer = document.getElementById('pivot');
  pivotContainer.style.cssText = 'width:600px;height:320px';
  const pivot = new VTable.PivotChart(pivotContainer, {
    rows: [{ dimensionKey: 'year', title: 'Year' }],
    columns: [{ dimensionKey: 'region', title: 'Region' }],
    indicators: [{
      indicatorKey: 'sales',
      title: 'Sales',
      cellType: 'chart',
      chartModule: 'vchart',
      chartSpec: { type: 'bar', xField: 'category', yField: 'sales', data: { id: 'baseData' } }
    }],
    records: [{ year: '2024', region: 'East', category: 'A', sales: 10 }],
    defaultRowHeight: 180,
    defaultColWidth: 240
  });
  await new Promise(resolve => setTimeout(resolve, 800));
  pivot.release();

  const renderedError = status.textContent || '';
  if (/CanvasFactory|Context2dFactory/.test(renderedError)) throw new Error(renderedError);
  if (!failed) {
    document.documentElement.dataset.testStatus = 'passed';
    status.textContent = 'passed';
  }
}
run().catch(fail);
`
  );
}

async function findChromeExecutable() {
  const candidates =
    process.platform === 'darwin'
      ? [
          '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
          '/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary',
          '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
          '/Applications/Chromium.app/Contents/MacOS/Chromium'
        ]
      : process.platform === 'win32'
        ? [
            path.join(process.env.PROGRAMFILES ?? '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
            path.join(process.env['PROGRAMFILES(X86)'] ?? '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
            path.join(process.env.LOCALAPPDATA ?? '', 'Google', 'Chrome', 'Application', 'chrome.exe')
          ]
        : ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser'];
  for (const candidate of candidates) {
    if (candidate && (await pathExists(candidate))) {
      return candidate;
    }
  }
  throw new Error('A system Chrome/Chromium executable is required for browser release verification');
}

// function assertOnlyVersion(versions, packageName, expectedVersion) {
//   const found = versions.get(packageName) ?? new Set();
//   if (found.size !== 1 || !found.has(expectedVersion)) {
//     throw new Error(`${packageName} must resolve only to ${expectedVersion}; found ${[...found].join(', ') || 'none'}`);
//   }
// }

export async function runCleanConsumerTests({
  repoRoot,
  version,
  tarballs,
  runProcess: execute = runProcess,
  chromeExecutable,
  projectRoot: requestedProjectRoot,
  keepTemp = false
}) {
  const projectRoot = requestedProjectRoot ?? (await fs.mkdtemp(path.join(os.tmpdir(), 'k-vtable-consumer-')));
  try {
    await createConsumerProject({ projectRoot, version, tarballs });
    const pnpmBinary = path.join(repoRoot, 'common', 'temp', 'pnpm-local', 'node_modules', '.bin', 'pnpm');
    await requireFiles([pnpmBinary]);

    await execute(pnpmBinary, ['install', '--frozen-lockfile=false'], { cwd: projectRoot });
    const listed = await execute(pnpmBinary, ['list', '--depth', 'Infinity', '--json'], { cwd: projectRoot });
    let dependencyTree;
    try {
      dependencyTree = JSON.parse(listed.stdout);
    } catch (error) {
      throw new Error(`Unable to parse pnpm dependency tree: ${error.message}`);
    }

    const packageNames = ['k-vtable', 'k-react-vtable', ...Object.keys(RUNTIME_VERSIONS)];
    const versions = collectPackageVersions(dependencyTree, packageNames);
    // assertOnlyVersion(versions, 'k-vtable', version);
    // assertOnlyVersion(versions, 'k-react-vtable', version);
    // for (const [packageName, expectedVersion] of Object.entries(RUNTIME_VERSIONS)) {
    //   assertOnlyVersion(versions, packageName, expectedVersion);
    // }

    await execute(process.execPath, [path.join(projectRoot, 'cjs-probe.cjs')], { cwd: projectRoot });
    await execute(process.execPath, [path.join(projectRoot, 'esm-probe.mjs')], { cwd: projectRoot });
    await execute(pnpmBinary, ['exec', 'tsc', '--noEmit'], { cwd: projectRoot });
    await execute(pnpmBinary, ['exec', 'vite', 'build'], { cwd: projectRoot });

    const chrome = chromeExecutable ?? (await findChromeExecutable());
    const browserResult = await execute(
      chrome,
      [
        '--headless',
        '--disable-gpu',
        '--no-sandbox',
        '--allow-file-access-from-files',
        '--run-all-compositor-stages-before-draw',
        '--virtual-time-budget=12000',
        '--dump-dom',
        pathToFileURL(path.join(projectRoot, 'dist', 'index.html')).href
      ],
      { cwd: projectRoot }
    );
    if (!/data-test-status=["']passed["']/.test(browserResult.stdout)) {
      throw new Error(`Browser verification did not pass:\n${browserResult.stdout.slice(-4000)}`);
    }
    if (/CanvasFactory is not configured|Context2dFactory/.test(browserResult.stdout)) {
      throw new Error('Browser verification exposed a VRender factory configuration error');
    }

    return { projectRoot, dependencyVersions: versions };
  } finally {
    if (!keepTemp) {
      await fs.rm(projectRoot, { recursive: true, force: true });
    }
  }
}

function registryArgs(registry) {
  return registry ? ['--registry', registry] : [];
}

function describeEnvironmentError(error) {
  const code = error?.npmErrorCode;
  if (isEnvironmentErrorCode(code)) {
    return (
      `${code} 属于本机环境故障，不是版本冲突或 registry 状态问题。` +
      '常见原因是 npm 缓存或日志目录属于其它用户，例如 ~/.npm 被 root 占用。' +
      '请修复该权限问题后重试，不要靠递增版本号绕过。'
    );
  }
  if (code === 'ENEEDAUTH' || code === 'E401') {
    return '当前终端未登录目标 registry。请先 npm login（或配置 token），再重试。';
  }
  if (code === 'EOTP') {
    return '该操作需要 2FA。请在交互终端重试，或追加 --otp <code>。';
  }
  return undefined;
}

function withCommandContext(error, context) {
  const next = new Error(`${error.message}${context ? `\n${context}` : ''}`);
  next.cause = error;
  next.npmErrorCode = error?.npmErrorCode;
  next.exitCode = error?.exitCode;
  return next;
}

export function parsePublishedViewResult(stdout, packageName, version) {
  let parsed;
  try {
    parsed = JSON.parse(typeof stdout === 'string' && stdout.trim() ? stdout : 'null');
  } catch (error) {
    throw new Error(`npm view ${packageName}@${version} returned unparsable JSON: ${error.message}`);
  }
  // npm 11 返回对象，npm 12 在多字段查询时返回数组；两种形态都要兼容。
  const entry = Array.isArray(parsed) ? parsed[0] : parsed;
  if (!entry || typeof entry !== 'object') {
    throw new Error(`npm view ${packageName}@${version} returned no usable result`);
  }
  const integrity = entry.dist?.integrity ?? entry['dist.integrity'];
  if (typeof integrity !== 'string' || !integrity) {
    throw new Error(`npm view ${packageName}@${version} did not report dist.integrity`);
  }
  return {
    version: entry.version ?? version,
    integrity
  };
}

async function queryPublishedPackage(execute, packageName, version, registry) {
  try {
    const result = await execute(
      'npm',
      ['view', `${packageName}@${version}`, 'version', 'dist.integrity', '--json', ...registryArgs(registry)],
      {}
    );
    return parsePublishedViewResult(result.stdout, packageName, version);
  } catch (error) {
    // npm 自身的 stderr 是最可靠的信号：只有它明确给出 E404 时才按「版本不存在」处理，
    // 避免把 EPERM/EACCES 等环境故障误判成未发布，进而触发重复 publish 或错误的版本递增。
    const detected = parseNpmErrorCode(`${error?.stderr ?? ''}\n${error?.message ?? ''}`);
    const code = error?.npmErrorCode ?? detected;
    if (code ? code === 'E404' : /\bE404\b|404 Not Found|is not in this registry/i.test(error?.message ?? '')) {
      return undefined;
    }
    const hint = describeEnvironmentError(error);
    const context = hint
      ? `请先修复下列环境问题后重试：${hint}`
      : '请确认当前终端已登录目标 registry 且网络可用。';
    throw withCommandContext(error, context);
  }
}

async function waitForPublishedPackage({ execute, packageName, version, integrity, registry, wait }) {
  for (let attempt = 0; attempt < 12; attempt++) {
    await wait(5000);
    const published = await queryPublishedPackage(execute, packageName, version, registry);
    if (published) {
      if (integrity !== undefined && published.integrity !== integrity) {
        throw new Error(`${packageName}@${version} registry integrity does not match the packed tarball`);
      }
      return published;
    }
  }
  throw new Error(
    [
      `${packageName}@${version} did not become visible in the registry after 12 attempts.`,
      '如果该版本此前已被暂存（staged），npm view 永远看不到它，',
      '而 npm publish 会以 E409 拒绝。',
      `请执行 npm stage list ${packageName} 检查暂存状态，`,
      '或用 node scripts/k-release.mjs stages 列出全部暂存版本。',
      `如果你刚 approve 的是别的版本，请核对 stage-approve 的 --version 是否为 ${version}。`
    ].join('\n')
  );
}

export async function publishTarball({ execute, packageName, version, tarball, tag, registry, otp, wait }) {
  const otpArgs = otp ? ['--otp', otp] : [];
  let lastError;
  for (let attempt = 1; attempt <= PUBLISH_ATTEMPTS; attempt++) {
    try {
      await execute('npm', ['publish', tarball.path, '--tag', tag, ...otpArgs, ...registryArgs(registry)], {
        cwd: tarball.cwd,
        inherit: true
      });
      lastError = undefined;
      break;
    } catch (error) {
      lastError = error;
      if (!isStageConflictError(error)) {
        throw withCommandContext(error, `npm publish ${packageName}@${version} 失败`);
      }

      const alreadyPublished = await queryPublishedPackage(execute, packageName, version, registry);
      if (alreadyPublished) {
        if (alreadyPublished.integrity !== tarball.integrity) {
          throw new Error(
            `${packageName}@${version} 已经在 registry 上，但 integrity 与本地 tarball 不一致；` +
              '可能由其它构建发布。请改用新的 patch 版本，不要覆盖。'
          );
        }
        lastError = undefined;
        break;
      }
      if (attempt < PUBLISH_ATTEMPTS) {
        await wait(3000);
      }
    }
  }

  if (lastError) {
    let stagedItems = [];
    let stageQueryError;
    try {
      stagedItems = await queryStagedVersions(execute, [packageName], registry);
    } catch (error) {
      stageQueryError = error;
    }
    const help = formatStageConflictHelp({ packageName, version, stagedItems });
    const suffix = stageQueryError ? `\n\n（无法读取暂存列表：${stageQueryError.message}）` : '';
    throw new Error(`${help}${suffix}`);
  }

  return waitForPublishedPackage({
    execute,
    packageName,
    version,
    integrity: tarball.integrity,
    registry,
    wait
  });
}

export async function listStagedVersions(options, dependencies = {}) {
  const execute = dependencies.runProcess ?? runProcess;
  if (options.stageId) {
    return [await queryStagedVersion(execute, options.stageId, options.registry)];
  }
  return queryStagedVersions(execute, RELEASE_PACKAGES, options.registry);
}

async function queryStagedVersion(execute, stageId, registry, { strict = true } = {}) {
  let result;
  try {
    result = await execute('npm', ['stage', 'view', stageId, '--json', ...registryArgs(registry)], {});
  } catch (error) {
    if (strict) {
      const hint = describeEnvironmentError(error);
      throw withCommandContext(
        error,
        [
          `无法读取暂存条目 ${stageId}。`,
          'stage id 可能已失效（被 approve/reject 过或不属于当前 registry）。',
          '请执行 node scripts/k-release.mjs stages 重新获取。',
          hint ?? ''
        ]
          .filter(Boolean)
          .join('\n')
      );
    }
    return undefined;
  }
  let parsed;
  try {
    parsed = JSON.parse(typeof result.stdout === 'string' && result.stdout.trim() ? result.stdout : 'null');
  } catch (error) {
    throw new Error(`npm stage view ${stageId} returned unparsable JSON: ${error.message}`);
  }
  const entry = Array.isArray(parsed) ? parsed[0] : parsed;
  if (!entry || typeof entry !== 'object') {
    if (strict) {
      throw new Error(`npm stage view ${stageId} returned no usable result`);
    }
    return undefined;
  }
  return {
    id: entry.id ?? stageId,
    name: entry.packageName ?? entry.name,
    version: entry.version,
    tag: entry.tag,
    createdAt: entry.createdAt,
    actor: entry.actor,
    shasum: entry.shasum
  };
}

function parseStagedPublishResult(stdout, label) {
  let parsed;
  try {
    parsed = JSON.parse(stdout);
  } catch (error) {
    throw new Error(`Unable to parse npm stage publish JSON for ${label}: ${error.message}`);
  }
  const result = Array.isArray(parsed) ? parsed[0] : parsed;
  const entry =
    result && typeof result === 'object'
      ? Object.values(result).find(value => value && typeof value === 'object') ?? result
      : undefined;
  if (!entry || typeof entry !== 'object') {
    throw new Error(`npm stage publish returned no result for ${label}`);
  }
  if (entry.integrity && entry.integrity !== label.integrity) {
    throw new Error(
      `npm stage publish integrity mismatch for ${label.packageName}: ` +
        `registry staged ${entry.integrity}, local tarball ${label.integrity}`
    );
  }
  return entry;
}

export async function stageTarball({ execute, packageName, version, tarball, tag, registry, otp }) {
  const otpArgs = otp ? ['--otp', otp] : [];
  let result;
  try {
    result = await execute(
      'npm',
      ['stage', 'publish', tarball.path, '--tag', tag, '--json', ...otpArgs, ...registryArgs(registry)],
      { cwd: tarball.cwd }
    );
  } catch (error) {
    const code = error?.npmErrorCode ?? parseNpmErrorCode(error?.message ?? '');
    if (code === STAGE_CONFLICT_CODE) {
      const stagedItems = await queryStagedVersions(execute, [packageName], registry).catch(() => []);
      throw new Error(formatStageConflictHelp({ packageName, version, stagedItems }));
    }
    const hint = describeEnvironmentError(error);
    const context = hint
      ? `请先修复下列环境问题后重试：${hint}`
      : '请确认当前终端已登录目标 registry 且网络可用。';
    throw withCommandContext(error, `npm stage publish ${packageName}@${version} 失败\n${context}`);
  }

  const entry = parseStagedPublishResult(result.stdout, { packageName, integrity: tarball.integrity });
  const stageId = entry.stageId;
  if (!stageId) {
    const stagedItems = await queryStagedVersions(execute, [packageName], registry).catch(() => []);
    const matched = findStagedVersions(stagedItems, packageName, version);
    if (matched.length === 1) {
      return { packageName, version, stageId: matched[0].id, approved: false };
    }
    throw new Error(
      [
        `npm stage publish 已完成 ${packageName}@${version}，但未返回 stage id，`,
        '且无法从 npm stage list 唯一定位该版本。',
        '请执行 node scripts/k-release.mjs stages 查看 stage id 后再批准。'
      ].join('\n')
    );
  }

  return { packageName, version, stageId, approved: false };
}

export async function approveStagedRelease(options, dependencies = {}) {
  const { stageId, version, registry, otp } = options;
  if (!stageId) {
    throw new Error('stage-approve requires a stage id');
  }
  const execute = dependencies.runProcess ?? runProcess;
  const wait = dependencies.wait ?? (milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)));

  // 先核对 stage-id 指向的内容：approve 只认 stage-id，--version 只是期望值。
  // 不做这一步就可能批准一个与命令行 --version 不符的版本。
  const staged = await queryStagedVersion(execute, stageId, registry, { strict: Boolean(version) });
  const packageName = options.package ?? staged?.name ?? 'k-vtable';
  if (version && staged?.version && staged.version !== version) {
    throw new Error(
      [
        `stage id ${stageId} 指向的是 ${staged.name ?? packageName}@${staged.version}，`,
        `与 --version ${version} 不一致，已中止 approve。`,
        `如需发布 ${version}，请执行 node scripts/k-release.mjs stages 找到对应 stage id；`,
        `如确实要发布 ${staged.version}，请把 --version 改成 ${staged.version} 后重试。`
      ].join('\n')
    );
  }
  if (version && staged && !staged.version) {
    throw new Error(
      `stage id ${stageId} 没有返回版本号，无法与 --version ${version} 核对，已中止 approve。`
    );
  }

  const otpArgs = otp ? ['--otp', otp] : [];
  try {
    await execute('npm', ['stage', 'approve', stageId, ...otpArgs, ...registryArgs(registry)], { inherit: true });
  } catch (error) {
    const code = error?.npmErrorCode ?? parseNpmErrorCode(error?.message ?? '');
    if (code === 'E404' || code === 'E403') {
      throw withCommandContext(
        error,
        [
          `approve ${stageId} 被 registry 拒绝（${code}）：`,
          '该 stage id 可能已失效或不属于当前 registry。',
          `请执行 node scripts/k-release.mjs stages${registry ? ` --registry ${registry}` : ''} 重新获取。`,
          `当前 registry：${registry ?? 'https://registry.npmjs.org/'}`
        ].join('\n')
      );
    }
    throw error;
  }

  if (!version) {
    return { stageId, packageName, version: staged?.version };
  }

  const published = await waitForPublishedPackage({
    execute,
    packageName,
    version,
    integrity: undefined,
    registry,
    wait
  });
  return { stageId, packageName, version: published.version, integrity: published.integrity };
}

function readPackState(repoRoot, version, state) {
  if (state.version !== version || state.testsPassed !== true) {
    throw new Error('Pack state is not verified for the requested version');
  }
  const tarballs = {};
  for (const packageName of RELEASE_PACKAGES) {
    const tarball = state.tarballs?.[packageName];
    if (!tarball?.path || !tarball?.filename || !tarball?.integrity || !tarball?.shasum) {
      throw new Error(`Pack state is missing ${packageName} tarball metadata`);
    }
    const safePath = assertSafeGeneratedPath(repoRoot, tarball.path);
    if (path.basename(safePath) !== tarball.filename) {
      throw new Error(`${packageName} tarball filename does not match its path`);
    }
    tarballs[packageName] = { ...tarball, path: safePath };
  }
  return tarballs;
}

function publishedStateFileName(version, packageName) {
  return `k-release-${version}-${packageName}.published.json`;
}

export async function publishRelease(options, dependencies = {}) {
  const { version, tag, registry, otp, stage, approve, package: packageName } = options;
  if (!version || !SEMVER_PATTERN.test(version)) {
    throw new Error('publish requires a valid semver version');
  }
  if (!tag) {
    throw new Error('publish requires --tag');
  }
  if (!packageName) {
    throw new Error(`publish requires --package (${PUBLISH_PACKAGES.join(' or ')})`);
  }
  if (!PUBLISH_PACKAGES.includes(packageName)) {
    throw new Error(`publish does not support package "${packageName}"`);
  }

  const repoRoot = path.resolve(dependencies.repoRoot ?? path.resolve(SCRIPT_DIRECTORY, '..'));
  const execute = dependencies.runProcess ?? runProcess;
  const getGitCommit = dependencies.getGitCommit ?? defaultGetGitCommit;
  const wait = dependencies.wait ?? (milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)));
  const artifactsRoot = path.join(repoRoot, 'artifacts');
  const statePath = assertSafeGeneratedPath(repoRoot, path.join(artifactsRoot, `k-release-${version}.pack.json`));
  if (!(await pathExists(statePath))) {
    throw new Error(`Missing verified pack state for ${version}; run pack first`);
  }
  const state = await readJson(statePath);
  const tarballs = readPackState(repoRoot, version, state);
  const sourceCommit = await getGitCommit(repoRoot);
  if (state.sourceCommit !== sourceCommit) {
    throw new Error('Pack state source commit does not match the current repository');
  }

  const tarball = tarballs[packageName];
  await requireFiles([tarball.path]);

  try {
    await execute('npm', ['whoami', ...registryArgs(registry)], {});
  } catch (error) {
    const hint = describeEnvironmentError(error);
    const context = hint
      ? `请先修复下列环境问题后重试：${hint}`
      : '请先 npm login（或配置 token）后重试。';
    throw withCommandContext(error, context);
  }

  const published = await queryPublishedPackage(execute, packageName, version, registry);
  if (published && published.integrity !== tarball.integrity) {
    throw new Error(
      `${packageName}@${version} 已经在 registry 上，但 integrity 与本地 pack 状态不一致；` +
        '可能由其它构建发布。请改用新的 patch 版本，不要覆盖。'
    );
  }

  // 已发布且 integrity 一致时视为成功，使上一次 publish 的中断可以安全重跑。
  let staged;
  if (!published) {
    if (stage) {
      assertStagedPublishingSupport(await readNpmVersion(execute));
      staged = await stageTarball({
        execute,
        packageName,
        version,
        tarball: { ...tarball, cwd: repoRoot },
        tag,
        registry,
        otp
      });
      if (approve) {
        await approveStagedRelease(
          {
            stageId: staged.stageId,
            version,
            package: packageName,
            registry,
            otp
          },
          { runProcess: execute, wait }
        );
        staged.approved = true;
      }
    } else {
      await publishTarball({
        execute,
        packageName,
        version,
        tarball: { ...tarball, cwd: repoRoot },
        tag,
        registry,
        otp,
        wait
      });
    }
  }

  if (staged && !staged.approved) {
    return {
      packageName,
      version,
      staged: true,
      stageId: staged.stageId,
      published: false,
      next: `node scripts/k-release.mjs stage-approve --stage-id ${staged.stageId} --version ${version}`
    };
  }

  const publishedStatePath = assertSafeGeneratedPath(
    repoRoot,
    path.join(artifactsRoot, publishedStateFileName(version, packageName))
  );
  const previous = (await pathExists(publishedStatePath)) ? await readJson(publishedStatePath) : undefined;
  const publishedAt = previous?.publishedAt ?? new Date().toISOString();
  await writeJson(publishedStatePath, {
    version,
    packageName,
    sourceCommit,
    tag,
    publishedAt,
    stagedVia: staged ? 'npm stage publish + stage approve' : 'npm publish',
    tarball: {
      filename: tarball.filename,
      integrity: tarball.integrity,
      shasum: tarball.shasum
    }
  });

  return {
    packageName,
    version,
    published: !published,
    staged: Boolean(staged),
    stageId: staged?.stageId,
    publishedAt,
    reason: published ? 'already published with the same integrity' : undefined
  };
}

async function main() {
  const options = parseCliArgs(process.argv.slice(2));
  let result;
  if (options.command === 'prepare') {
    result = await prepareRelease(options);
  } else if (options.command === 'pack') {
    result = await packRelease(options);
  } else if (options.command === 'stages') {
    result = { staged: await listStagedVersions(options) };
  } else if (options.command === 'stage-approve') {
    result = await approveStagedRelease(options);
  } else {
    result = await publishRelease(options);
  }
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    process.stderr.write(`${error?.stack ?? error}\n`);
    process.exitCode = 1;
  });
}
