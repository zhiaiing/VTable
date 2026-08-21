import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  RUNTIME_VERSIONS,
  assertSafeGeneratedPath,
  buildReactManifest,
  buildVtableManifest,
  collectPackageVersions,
  createConsumerProject,
  packRelease,
  parseCliArgs,
  prepareRelease,
  publishRelease,
  replaceVtableReferences,
  resolvePublishMode,
  runProcess,
  runCleanConsumerTests,
  rewriteEntryVersion,
  validatePackFileList
} from './k-release.mjs';

const vtableFixture = {
  name: '@visactor/vtable',
  version: '1.26.5',
  description: 'VTable',
  main: 'cjs/index.js',
  module: 'es/index.js',
  types: 'es/index.d.ts',
  scripts: { build: 'bundler' },
  devDependencies: { typescript: '5.2.2' },
  dependencies: {
    '@visactor/vtable-editors': 'workspace:1.26.5',
    '@visactor/vrender': '1.1.4',
    '@visactor/vrender-core': '1.1.4',
    '@visactor/vrender-kits': '1.1.4',
    '@visactor/vrender-components': '1.1.4',
    '@visactor/vrender-animate': '1.1.4',
    lodash: '4.17.21'
  }
};

const reactFixture = {
  name: '@visactor/react-vtable',
  version: '1.26.5',
  description: 'React VTable',
  main: 'cjs/index.js',
  module: 'es/index.js',
  types: 'es/index.d.ts',
  exports: {
    '.': {
      require: './cjs/index.js',
      import: './es/index.js'
    }
  },
  scripts: { build: 'bundler' },
  devDependencies: { typescript: '5.2.2' },
  dependencies: {
    '@visactor/vtable': 'workspace:1.26.5',
    '@visactor/vutils': '~1.0.17',
    'react-is': '^18.2.0',
    'react-reconciler': '0.29.0'
  },
  peerDependencies: {
    react: '^18.2.0 || ^19.0.0',
    'react-dom': '^18.2.0 || ^19.0.0'
  }
};

async function createFixtureRepo(t) {
  const repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'k-release-fixture-'));
  t.after(() => fs.rm(repoRoot, { recursive: true, force: true }));
  await fs.mkdir(path.join(repoRoot, 'packages', 'vtable', 'es'), { recursive: true });
  await fs.mkdir(path.join(repoRoot, 'packages', 'vtable', 'cjs'), { recursive: true });
  await fs.mkdir(path.join(repoRoot, 'packages', 'react-vtable', 'es'), { recursive: true });
  await fs.mkdir(path.join(repoRoot, 'packages', 'react-vtable', 'cjs'), { recursive: true });
  await fs.writeFile(path.join(repoRoot, 'rush.json'), JSON.stringify({ pnpmVersion: '10.7.0' }));
  await fs.writeFile(path.join(repoRoot, 'LICENSE'), 'license');
  for (const [packageFolder, manifest] of [
    ['vtable', vtableFixture],
    ['react-vtable', reactFixture]
  ]) {
    const packageRoot = path.join(repoRoot, 'packages', packageFolder);
    await fs.writeFile(path.join(packageRoot, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`);
    await fs.writeFile(path.join(packageRoot, 'README.md'), `${packageFolder} readme`);
    await fs.writeFile(path.join(packageRoot, 'es', 'index.d.ts'), 'export declare const version: string;\n');
    await fs.writeFile(path.join(packageRoot, 'es', 'index.js'), 'export const version = "1.26.5";\n');
    await fs.writeFile(path.join(packageRoot, 'es', 'index.js.map'), '{"versionText":"1.26.5"}\n');
    await fs.writeFile(path.join(packageRoot, 'cjs', 'index.js'), 'exports.version = "1.26.5";\n');
    await fs.writeFile(path.join(packageRoot, 'cjs', 'index.js.map'), '{"versionText":"1.26.5"}\n');
  }
  return repoRoot;
}

test('parseCliArgs parses prepare arguments', () => {
  assert.deepEqual(parseCliArgs(['prepare', '--version', '1.0.40', '--skip-build']), {
    command: 'prepare',
    version: '1.0.40',
    registry: undefined,
    tag: undefined,
    skipBuild: true
  });
});

test('parseCliArgs rejects invalid commands and versions', () => {
  assert.throws(() => parseCliArgs(['unknown', '--version', '1.0.40']), /command/i);
  assert.throws(() => parseCliArgs(['prepare', '--version', 'latest']), /valid semver/i);
  assert.throws(() => parseCliArgs(['publish', '--version', '1.0.40']), /--tag/);
  assert.throws(() => parseCliArgs(['pack', '--version', '1.0.40', '--skip-build']), /prepare/);
});

test('runProcess includes stdout and stderr when a command fails', async () => {
  await assert.rejects(
    runProcess(
      process.execPath,
      [
        '-e',
        'process.stdout.write(process.env.K_RELEASE_TEST_STDOUT); process.stderr.write(process.env.K_RELEASE_TEST_STDERR); process.exit(2)'
      ],
      {
        env: {
          ...process.env,
          K_RELEASE_TEST_STDOUT: 'stdout detail',
          K_RELEASE_TEST_STDERR: 'stderr detail'
        }
      }
    ),
    error => {
      assert.match(error.message, /stdout detail/);
      assert.match(error.message, /stderr detail/);
      return true;
    }
  );
});

test('buildVtableManifest creates a registry-safe k-vtable manifest', () => {
  const manifest = buildVtableManifest(vtableFixture, '2.0.0');

  assert.equal(manifest.name, 'k-vtable');
  assert.equal(manifest.version, '2.0.0');
  assert.equal(manifest.scripts, undefined);
  assert.equal(manifest.devDependencies, undefined);
  assert.deepEqual(manifest.files, ['cjs', 'es']);
  assert.equal(manifest.dependencies['@visactor/vtable-editors'], '1.26.5');
  assert.equal(manifest.dependencies.lodash, '4.17.21');
  assert.deepEqual(
    Object.fromEntries(Object.keys(RUNTIME_VERSIONS).map(name => [name, manifest.dependencies[name]])),
    Object.fromEntries(Object.keys(RUNTIME_VERSIONS).map(name => [name, vtableFixture.dependencies[name]]))
  );
  assert.deepEqual(manifest.publishConfig, { access: 'public' });
});

test('buildReactManifest replaces the upstream core dependency with an exact peer', () => {
  const manifest = buildReactManifest(reactFixture, '2.0.0');

  assert.equal(manifest.name, 'k-react-vtable');
  assert.equal(manifest.version, '2.0.0');
  assert.equal(manifest.dependencies['@visactor/vtable'], undefined);
  assert.equal(manifest.dependencies['@visactor/vutils'], '~1.0.17');
  assert.equal(manifest.peerDependencies['k-vtable'], '2.0.0');
  assert.equal(manifest.peerDependencies.react, '^18.2.0 || ^19.0.0');
  assert.equal(manifest.peerDependencies['react-dom'], '^18.2.0 || ^19.0.0');
  assert.equal(manifest.exports, undefined);
  assert.equal(manifest.devDependencies, undefined);
  assert.deepEqual(manifest.files, ['cjs', 'es']);
});

test('replaceVtableReferences rewrites only the exact package identity', () => {
  const source = [
    "from '@visactor/vtable';",
    "from '@visactor/vtable/es/core';",
    "from '@visactor/vtable-editors';",
    "from '@visactor/vtable-plugins';",
    'sourceRoot=@visactor/vtable'
  ].join('\n');

  assert.equal(
    replaceVtableReferences(source),
    [
      "from 'k-vtable';",
      "from 'k-vtable/es/core';",
      "from '@visactor/vtable-editors';",
      "from '@visactor/vtable-plugins';",
      'sourceRoot=k-vtable'
    ].join('\n')
  );
});

test('replaceVtableReferences routes CJS runtime deep imports to k-vtable/cjs', () => {
  assert.equal(
    replaceVtableReferences(
      "const vrender = require('@visactor/vtable/es/vrender'); const core = require('@visactor/vtable');",
      { format: 'cjs' }
    ),
    "const vrender = require('k-vtable/cjs/vrender'); const core = require('k-vtable');"
  );
});

test('rewriteEntryVersion requires exactly one exported version literal', () => {
  assert.equal(
    rewriteEntryVersion('export const version = "1.26.5";', '1.26.5', '2.0.0'),
    'export const version = "2.0.0";'
  );
  assert.equal(
    rewriteEntryVersion('exports.version = "1.26.5";', '1.26.5', '2.0.0'),
    'exports.version = "2.0.0";'
  );
  assert.throws(() => rewriteEntryVersion('export const version = "1.0.0";', '1.26.5', '2.0.0'), /expected version/i);
  assert.throws(
    () => rewriteEntryVersion('export const version = "1.26.5"; const old = "1.26.5";', '1.26.5', '2.0.0'),
    /exactly once/i
  );
});

test('assertSafeGeneratedPath accepts only direct generated children', () => {
  const root = path.resolve('/workspace/VTable');

  assert.equal(
    assertSafeGeneratedPath(root, path.join(root, 'release', 'k-vtable')),
    path.join(root, 'release', 'k-vtable')
  );
  assert.equal(
    assertSafeGeneratedPath(root, path.join(root, 'artifacts', 'k-vtable-2.0.0.tgz')),
    path.join(root, 'artifacts', 'k-vtable-2.0.0.tgz')
  );
  assert.throws(() => assertSafeGeneratedPath(root, root), /generated path/i);
  assert.throws(() => assertSafeGeneratedPath(root, path.join(root, 'release')), /generated path/i);
  assert.throws(() => assertSafeGeneratedPath(root, path.resolve('/workspace/other')), /generated path/i);
  assert.throws(() => assertSafeGeneratedPath(root, path.join(root, 'release', 'nested', 'file')), /generated path/i);
});

test('validatePackFileList permits only the documented package surface', () => {
  const valid = {
    files: [
      { path: 'package.json' },
      { path: 'README.md' },
      { path: 'LICENSE' },
      { path: 'es/index.js' },
      { path: 'es/index.d.ts' },
      { path: 'cjs/index.js' }
    ]
  };

  assert.doesNotThrow(() => validatePackFileList(valid));
  assert.throws(() => validatePackFileList({ files: [...valid.files, { path: 'dist/index.js' }] }), /dist/);
  assert.throws(() => validatePackFileList({ files: [...valid.files, { path: 'src/index.ts' }] }), /src/);
  assert.throws(() => validatePackFileList({ files: [...valid.files, { path: 'pnpm-lock.yaml' }] }), /pnpm-lock/);
});

test('resolvePublishMode distinguishes first publish and safe React resume', () => {
  assert.deepEqual(resolvePublishMode(undefined, undefined, 'sha512-local'), {
    publishCore: true,
    publishReact: true
  });
  assert.deepEqual(resolvePublishMode({ integrity: 'sha512-local' }, undefined, 'sha512-local'), {
    publishCore: false,
    publishReact: true
  });
  assert.throws(() => resolvePublishMode({ integrity: 'sha512-other' }, undefined, 'sha512-local'), /integrity/i);
  assert.throws(() => resolvePublishMode(undefined, { integrity: 'sha512-react' }, 'sha512-local'), /React/i);
  assert.throws(
    () => resolvePublishMode({ integrity: 'sha512-local' }, { integrity: 'sha512-react' }, 'sha512-local'),
    /already exist/i
  );
});

test('prepareRelease generates isolated k packages from existing build output', async t => {
  const repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'k-release-prepare-'));
  t.after(() => fs.rm(repoRoot, { recursive: true, force: true }));

  await fs.mkdir(path.join(repoRoot, 'packages', 'vtable', 'es'), { recursive: true });
  await fs.mkdir(path.join(repoRoot, 'packages', 'vtable', 'cjs'), { recursive: true });
  await fs.mkdir(path.join(repoRoot, 'packages', 'react-vtable', 'es'), { recursive: true });
  await fs.mkdir(path.join(repoRoot, 'packages', 'react-vtable', 'cjs'), { recursive: true });
  await fs.writeFile(path.join(repoRoot, 'rush.json'), JSON.stringify({ pnpmVersion: '10.7.0' }));
  await fs.writeFile(path.join(repoRoot, 'LICENSE'), 'license');

  for (const [packageFolder, manifest] of [
    ['vtable', vtableFixture],
    ['react-vtable', reactFixture]
  ]) {
    const packageRoot = path.join(repoRoot, 'packages', packageFolder);
    await fs.writeFile(path.join(packageRoot, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`);
    await fs.writeFile(path.join(packageRoot, 'README.md'), `${packageFolder} readme`);
    await fs.writeFile(path.join(packageRoot, 'es', 'index.d.ts'), 'export declare const version: string;\n');
    await fs.writeFile(path.join(packageRoot, 'es', 'index.js'), 'export const version = "1.26.5";\n');
    await fs.writeFile(path.join(packageRoot, 'es', 'index.js.map'), '{"versionText":"1.26.5"}\n');
    await fs.writeFile(path.join(packageRoot, 'cjs', 'index.js'), 'exports.version = "1.26.5";\n');
    await fs.writeFile(path.join(packageRoot, 'cjs', 'index.js.map'), '{"versionText":"1.26.5"}\n');
  }

  const reactEsSource = [
    "export * from '@visactor/vtable';",
    "export * from '@visactor/vtable/es/core';",
    "export * from '@visactor/vtable-editors';"
  ].join('\n');
  await fs.writeFile(path.join(repoRoot, 'packages', 'react-vtable', 'es', 'component.js'), reactEsSource);
  await fs.writeFile(
    path.join(repoRoot, 'packages', 'react-vtable', 'cjs', 'component.js'),
    "require('@visactor/vtable'); require('@visactor/vtable-plugins');\n"
  );

  const result = await prepareRelease(
    { version: '2.0.0', skipBuild: true },
    { repoRoot, getGitCommit: async () => 'abc123' }
  );

  assert.equal(result.version, '2.0.0');
  assert.equal(result.sourceCommit, 'abc123');
  const vtableManifest = JSON.parse(await fs.readFile(path.join(repoRoot, 'release', 'k-vtable', 'package.json')));
  const reactManifest = JSON.parse(await fs.readFile(path.join(repoRoot, 'release', 'k-react-vtable', 'package.json')));
  assert.equal(vtableManifest.name, 'k-vtable');
  assert.equal(reactManifest.peerDependencies['k-vtable'], '2.0.0');
  assert.match(
    await fs.readFile(path.join(repoRoot, 'release', 'k-react-vtable', 'es', 'component.js'), 'utf8'),
    /k-vtable\/es\/core/
  );
  assert.match(
    await fs.readFile(path.join(repoRoot, 'release', 'k-react-vtable', 'es', 'component.js'), 'utf8'),
    /@visactor\/vtable-editors/
  );
  assert.match(await fs.readFile(path.join(repoRoot, 'release', 'k-vtable', 'es', 'index.js'), 'utf8'), /2\.0\.0/);
  assert.equal(
    await fs.readFile(path.join(repoRoot, 'packages', 'react-vtable', 'es', 'component.js'), 'utf8'),
    reactEsSource
  );
  assert.equal(
    JSON.parse(await fs.readFile(path.join(repoRoot, 'artifacts', 'k-release-2.0.0.prepare.json'))).sourceCommit,
    'abc123'
  );
  await assert.rejects(fs.access(path.join(repoRoot, 'release', 'k-vtable', 'dist')), /ENOENT/);
});

test('packRelease records exact tarballs only after consumer verification passes', async t => {
  const repoRoot = await createFixtureRepo(t);
  await prepareRelease(
    { version: '2.0.0', skipBuild: true },
    { repoRoot, getGitCommit: async () => 'abc123' }
  );

  const packedNames = [];
  const fakeRunProcess = async (command, args, options) => {
    assert.equal(command, 'npm');
    assert.equal(args[0], 'pack');
    const packageName = path.basename(options.cwd);
    const files = [
      { path: 'package.json' },
      { path: 'README.md' },
      { path: 'LICENSE' },
      { path: 'es/index.js' },
      { path: 'es/index.d.ts' },
      { path: 'cjs/index.js' }
    ];
    if (args.includes('--dry-run')) {
      return { stdout: JSON.stringify([{ files }]), stderr: '', code: 0 };
    }
    const filename = `${packageName}-2.0.0.tgz`;
    packedNames.push(filename);
    await fs.writeFile(path.join(repoRoot, 'artifacts', filename), `${packageName} tarball`);
    return {
      stdout: JSON.stringify([
        { filename, files, integrity: `sha512-${packageName}`, shasum: `sha-${packageName}` }
      ]),
      stderr: '',
      code: 0
    };
  };

  let consumerTestCalled = false;
  const state = await packRelease(
    { version: '2.0.0' },
    {
      repoRoot,
      getGitCommit: async () => 'abc123',
      runProcess: fakeRunProcess,
      runConsumerTests: async ({ tarballs, version }) => {
        consumerTestCalled = true;
        assert.equal(version, '2.0.0');
        assert.deepEqual(Object.keys(tarballs), ['k-vtable', 'k-react-vtable']);
      }
    }
  );

  assert.equal(consumerTestCalled, true);
  assert.deepEqual(packedNames, ['k-vtable-2.0.0.tgz', 'k-react-vtable-2.0.0.tgz']);
  assert.equal(state.testsPassed, true);
  assert.equal(state.tarballs['k-vtable'].integrity, 'sha512-k-vtable');
  assert.equal(state.tarballs['k-react-vtable'].filename, 'k-react-vtable-2.0.0.tgz');
  assert.equal(
    JSON.parse(await fs.readFile(path.join(repoRoot, 'artifacts', 'k-release-2.0.0.pack.json'))).testsPassed,
    true
  );
});

test('collectPackageVersions finds every nested pnpm occurrence', () => {
  const tree = [
    {
      name: 'consumer',
      dependencies: {
        'k-vtable': {
          version: '2.0.0',
          dependencies: {
            '@visactor/vrender-core': { version: '1.1.5' },
            '@visactor/vrender-kits': {
              version: '1.1.5',
              dependencies: { '@visactor/vrender-core': { version: '1.1.5' } }
            }
          }
        },
        '@visactor/vchart': {
          version: '2.1.3',
          dependencies: { '@visactor/vrender-core': { version: '1.1.5' } }
        }
      }
    }
  ];

  const versions = collectPackageVersions(tree, ['k-vtable', '@visactor/vrender-core', '@visactor/vrender-kits']);
  assert.deepEqual([...versions.get('k-vtable')], ['2.0.0']);
  assert.deepEqual([...versions.get('@visactor/vrender-core')], ['1.1.5']);
  assert.deepEqual([...versions.get('@visactor/vrender-kits')], ['1.1.5']);
});

test('createConsumerProject writes module, type, React custom layout, and PivotChart probes', async t => {
  const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'k-release-consumer-'));
  t.after(() => fs.rm(projectRoot, { recursive: true, force: true }));
  const tarballs = {
    'k-vtable': { path: '/tmp/k-vtable-2.0.0.tgz' },
    'k-react-vtable': { path: '/tmp/k-react-vtable-2.0.0.tgz' }
  };

  await createConsumerProject({ projectRoot, version: '2.0.0', tarballs });

  const manifest = JSON.parse(await fs.readFile(path.join(projectRoot, 'package.json')));
  assert.equal(manifest.dependencies['k-vtable'], 'file:/tmp/k-vtable-2.0.0.tgz');
  assert.equal(manifest.dependencies['@visactor/vchart'], '2.1.3');
  assert.equal(manifest.devDependencies.vite, '3.2.6');
  const tsconfig = JSON.parse(await fs.readFile(path.join(projectRoot, 'tsconfig.json')));
  assert.equal(tsconfig.compilerOptions.skipLibCheck, true);
  const typeProbe = await fs.readFile(path.join(projectRoot, 'type-probe.ts'), 'utf8');
  assert.match(typeProbe, /k-vtable\/es\/vrender/);
  assert.match(typeProbe, /BaseTableAPI.*k-vtable\/es\/ts-types/s);
  assert.match(typeProbe, /ComponentProps<typeof ListTable>/);
  const browserProbe = await fs.readFile(path.join(projectRoot, 'src', 'main.js'), 'utf8');
  assert.match(browserProbe, /customLayout/);
  assert.match(browserProbe, /PivotChart/);
  assert.match(browserProbe, /CanvasFactory/);
  assert.match(await fs.readFile(path.join(projectRoot, 'vite.config.js'), 'utf8'), /base: '\.\/'/);
});

test('runCleanConsumerTests requires one runtime version and a passing browser DOM', async t => {
  const repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'k-release-consumer-repo-'));
  const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'k-release-consumer-run-'));
  t.after(() => fs.rm(repoRoot, { recursive: true, force: true }));
  t.after(() => fs.rm(projectRoot, { recursive: true, force: true }));
  const pnpmBinary = path.join(repoRoot, 'common', 'temp', 'pnpm-local', 'node_modules', '.bin', 'pnpm');
  await fs.mkdir(path.dirname(pnpmBinary), { recursive: true });
  await fs.writeFile(pnpmBinary, 'fixture');

  const runtimeDependencies = Object.fromEntries(
    Object.keys(RUNTIME_VERSIONS).map(name => [name, { version: '1.1.5' }])
  );
  const listTree = [
    {
      name: 'consumer',
      dependencies: {
        'k-vtable': { version: '2.0.0', dependencies: runtimeDependencies },
        'k-react-vtable': { version: '2.0.0' },
        '@visactor/vchart': { version: '2.1.3', dependencies: runtimeDependencies }
      }
    }
  ];
  const calls = [];
  const fakeRunProcess = async (command, args, options) => {
    calls.push({ command, args, cwd: options?.cwd });
    if (command === '/fake/chrome') {
      return {
        stdout: '<html data-test-status="passed"><body>passed</body></html>',
        stderr: '',
        code: 0
      };
    }
    if (args.includes('list')) {
      return { stdout: JSON.stringify(listTree), stderr: '', code: 0 };
    }
    return { stdout: '', stderr: '', code: 0 };
  };

  await runCleanConsumerTests({
    repoRoot,
    projectRoot,
    keepTemp: true,
    version: '2.0.0',
    tarballs: {
      'k-vtable': { path: '/tmp/k-vtable-2.0.0.tgz' },
      'k-react-vtable': { path: '/tmp/k-react-vtable-2.0.0.tgz' }
    },
    runProcess: fakeRunProcess,
    chromeExecutable: '/fake/chrome'
  });

  const installCall = calls.find(call => call.args.includes('install'));
  assert.equal(installCall.args[0], 'install');
  assert.equal(installCall.cwd, projectRoot);
  assert.match(installCall.command, /pnpm$/);
  assert.equal(calls.some(call => call.args.includes('list')), true);
  assert.equal(calls.some(call => call.args.includes('tsc')), true);
  assert.equal(calls.some(call => call.args.includes('vite')), true);
  assert.equal(calls.some(call => call.command === '/fake/chrome'), true);
});

test('publishRelease publishes core first and waits before publishing React', async t => {
  const repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'k-release-publish-'));
  t.after(() => fs.rm(repoRoot, { recursive: true, force: true }));
  await fs.mkdir(path.join(repoRoot, 'artifacts'), { recursive: true });
  const corePath = path.join(repoRoot, 'artifacts', 'k-vtable-2.0.0.tgz');
  const reactPath = path.join(repoRoot, 'artifacts', 'k-react-vtable-2.0.0.tgz');
  await fs.writeFile(corePath, 'core');
  await fs.writeFile(reactPath, 'react');
  await fs.writeFile(
    path.join(repoRoot, 'artifacts', 'k-release-2.0.0.pack.json'),
    JSON.stringify({
      version: '2.0.0',
      sourceCommit: 'abc123',
      testsPassed: true,
      tarballs: {
        'k-vtable': {
          filename: path.basename(corePath),
          path: corePath,
          integrity: 'sha512-core',
          shasum: 'sha-core'
        },
        'k-react-vtable': {
          filename: path.basename(reactPath),
          path: reactPath,
          integrity: 'sha512-react',
          shasum: 'sha-react'
        }
      }
    })
  );

  const published = new Set();
  const commands = [];
  const fakeRunProcess = async (command, args) => {
    assert.equal(command, 'npm');
    commands.push(args);
    if (args[0] === 'whoami') {
      return { stdout: 'publisher\n', stderr: '', code: 0 };
    }
    if (args[0] === 'view') {
      const packageName = args[1].split('@2.0.0')[0];
      if (!published.has(packageName)) {
        const error = new Error('npm ERR! code E404');
        error.code = 'E404';
        throw error;
      }
      const integrity = packageName === 'k-vtable' ? 'sha512-core' : 'sha512-react';
      return {
        stdout: JSON.stringify({ version: '2.0.0', dist: { integrity } }),
        stderr: '',
        code: 0
      };
    }
    if (args[0] === 'publish') {
      published.add(path.basename(args[1]).startsWith('k-react') ? 'k-react-vtable' : 'k-vtable');
      return { stdout: 'published', stderr: '', code: 0 };
    }
    throw new Error(`Unexpected npm command: ${args.join(' ')}`);
  };

  const result = await publishRelease(
    { version: '2.0.0', tag: 'latest', registry: 'https://registry.example.test/' },
    {
      repoRoot,
      getGitCommit: async () => 'abc123',
      runProcess: fakeRunProcess,
      wait: async () => {}
    }
  );

  assert.deepEqual(result, { publishedCore: true, publishedReact: true });
  const publishCommands = commands.filter(args => args[0] === 'publish');
  assert.equal(path.basename(publishCommands[0][1]), 'k-vtable-2.0.0.tgz');
  assert.equal(path.basename(publishCommands[1][1]), 'k-react-vtable-2.0.0.tgz');
  assert.equal(publishCommands.every(args => args.includes('https://registry.example.test/')), true);
});
