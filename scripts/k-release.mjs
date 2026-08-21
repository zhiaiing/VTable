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

const COMMANDS = new Set(['prepare', 'pack', 'publish']);
const SEMVER_PATTERN =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;

export function parseCliArgs(argv) {
  const [command, ...rest] = argv;
  if (!COMMANDS.has(command)) {
    throw new Error(`Unknown command "${command ?? ''}"; expected prepare, pack, or publish`);
  }

  const result = {
    command,
    version: undefined,
    registry: undefined,
    tag: undefined,
    skipBuild: false
  };

  for (let index = 0; index < rest.length; index++) {
    const argument = rest[index];
    if (argument === '--skip-build') {
      result.skipBuild = true;
      continue;
    }

    if (argument === '--version' || argument === '--registry' || argument === '--tag') {
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

  if (!result.version || !SEMVER_PATTERN.test(result.version)) {
    throw new Error('--version must be a valid semver version');
  }
  if (result.skipBuild && command !== 'prepare') {
    throw new Error('--skip-build is only supported by prepare');
  }
  if (command === 'publish' && !result.tag) {
    throw new Error('publish requires --tag');
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

export function resolvePublishMode(corePackage, reactPackage, localCoreIntegrity) {
  if (!corePackage && !reactPackage) {
    return { publishCore: true, publishReact: true };
  }
  if (corePackage && !reactPackage) {
    if (corePackage.integrity !== localCoreIntegrity) {
      throw new Error('Published core integrity does not match the local tarball');
    }
    return { publishCore: false, publishReact: true };
  }
  if (!corePackage && reactPackage) {
    throw new Error('React package exists while the core package is missing');
  }
  throw new Error('Both package versions already exist');
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
    child.on('error', reject);
    child.on('close', code => {
      if (code !== 0) {
        const rendered = [command, ...args].join(' ');
        const details = [stdout.trim(), stderr.trim()].filter(Boolean).join('\n');
        reject(new Error(`Command failed (${code}): ${rendered}${details ? `\n${details}` : ''}`));
        return;
      }
      resolve({ stdout, stderr, code });
    });
  });
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

async function queryPublishedPackage(execute, packageName, version, registry) {
  try {
    const result = await execute(
      'npm',
      ['view', `${packageName}@${version}`, 'version', 'dist.integrity', '--json', ...registryArgs(registry)],
      {}
    );
    const parsed = JSON.parse(result.stdout);
    return {
      version: parsed.version ?? version,
      integrity: parsed.dist?.integrity ?? parsed['dist.integrity']
    };
  } catch (error) {
    if (error?.code === 'E404' || /\bE404\b|404 Not Found|is not in this registry/i.test(error?.message ?? '')) {
      return undefined;
    }
    throw error;
  }
}

async function waitForPublishedPackage({ execute, packageName, version, integrity, registry, wait }) {
  for (let attempt = 0; attempt < 12; attempt++) {
    const published = await queryPublishedPackage(execute, packageName, version, registry);
    if (published) {
      if (published.integrity !== integrity) {
        throw new Error(`${packageName}@${version} registry integrity does not match the packed tarball`);
      }
      return published;
    }
    await wait(5000);
  }
  throw new Error(`${packageName}@${version} did not become visible in the registry`);
}

export async function publishRelease(options, dependencies = {}) {
  const { version, tag, registry } = options;
  if (!version || !SEMVER_PATTERN.test(version)) {
    throw new Error('publish requires a valid semver version');
  }
  if (!tag) {
    throw new Error('publish requires --tag');
  }

  const repoRoot = path.resolve(dependencies.repoRoot ?? path.resolve(SCRIPT_DIRECTORY, '..'));
  const execute = dependencies.runProcess ?? runProcess;
  const getGitCommit = dependencies.getGitCommit ?? defaultGetGitCommit;
  const wait = dependencies.wait ?? (milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)));
  const statePath = assertSafeGeneratedPath(
    repoRoot,
    path.join(repoRoot, 'artifacts', `k-release-${version}.pack.json`)
  );
  if (!(await pathExists(statePath))) {
    throw new Error(`Missing verified pack state for ${version}`);
  }
  const state = await readJson(statePath);
  if (state.version !== version || state.testsPassed !== true) {
    throw new Error('Pack state is not verified for the requested version');
  }
  const sourceCommit = await getGitCommit(repoRoot);
  if (state.sourceCommit !== sourceCommit) {
    throw new Error('Pack state source commit does not match the current repository');
  }

  for (const packageName of ['k-vtable', 'k-react-vtable']) {
    const tarball = state.tarballs?.[packageName];
    if (!tarball?.path || !tarball?.filename || !tarball?.integrity || !tarball?.shasum) {
      throw new Error(`Pack state is missing ${packageName} tarball metadata`);
    }
    const safePath = assertSafeGeneratedPath(repoRoot, tarball.path);
    if (path.basename(safePath) !== tarball.filename) {
      throw new Error(`${packageName} tarball filename does not match its path`);
    }
    await requireFiles([safePath]);
  }

  await execute('npm', ['whoami', ...registryArgs(registry)], {});
  const [corePackage, reactPackage] = await Promise.all([
    queryPublishedPackage(execute, 'k-vtable', version, registry),
    queryPublishedPackage(execute, 'k-react-vtable', version, registry)
  ]);
  const mode = resolvePublishMode(corePackage, reactPackage, state.tarballs['k-vtable'].integrity);

  if (mode.publishCore) {
    await execute(
      'npm',
      ['publish', state.tarballs['k-vtable'].path, '--tag', tag, ...registryArgs(registry)],
      { cwd: repoRoot, inherit: true }
    );
    await waitForPublishedPackage({
      execute,
      packageName: 'k-vtable',
      version,
      integrity: state.tarballs['k-vtable'].integrity,
      registry,
      wait
    });
  }

  if (mode.publishReact) {
    await execute(
      'npm',
      ['publish', state.tarballs['k-react-vtable'].path, '--tag', tag, ...registryArgs(registry)],
      { cwd: repoRoot, inherit: true }
    );
    await waitForPublishedPackage({
      execute,
      packageName: 'k-react-vtable',
      version,
      integrity: state.tarballs['k-react-vtable'].integrity,
      registry,
      wait
    });
  }

  return { publishedCore: mode.publishCore, publishedReact: mode.publishReact };
}

async function main() {
  const options = parseCliArgs(process.argv.slice(2));
  let result;
  if (options.command === 'prepare') {
    result = await prepareRelease(options);
  } else if (options.command === 'pack') {
    result = await packRelease(options);
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
