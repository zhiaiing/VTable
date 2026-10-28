import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  RUNTIME_VERSIONS,
  approveStagedRelease,
  assertSafeGeneratedPath,
  assertStagedPublishingSupport,
  buildReactManifest,
  buildVtableManifest,
  collectPackageVersions,
  createConsumerProject,
  findStagedVersions,
  formatStageConflictHelp,
  isEnvironmentErrorCode,
  isStageConflictError,
  listStagedVersions,
  parseCliArgs,
  parseNpmErrorCode,
  parsePublishedViewResult,
  packRelease,
  prepareRelease,
  publishRelease,
  publishTarball,
  replaceVtableReferences,
  runProcess,
  runCleanConsumerTests,
  rewriteEntryVersion,
  stageTarball,
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
    otp: undefined,
    stageId: undefined,
    package: undefined,
    stage: false,
    approve: false,
    skipBuild: true
  });
});

test('parseCliArgs rejects invalid commands and versions', () => {
  assert.throws(() => parseCliArgs(['unknown', '--version', '1.0.40']), /command/i);
  assert.throws(() => parseCliArgs(['prepare', '--version', 'latest']), /valid semver/i);
  assert.throws(() => parseCliArgs(['publish', '--version', '1.0.40']), /--tag/);
  assert.throws(() => parseCliArgs(['pack', '--version', '1.0.40', '--skip-build']), /prepare/);
  assert.throws(
    () =>
      parseCliArgs([
        'publish',
        '--version',
        '1.0.40',
        '--tag',
        'latest',
        '--package',
        'k-vtable',
        '--stage-id',
        'x'
      ]),
    /--stage-id/
  );
  assert.equal(
    parseCliArgs([
      'publish',
      '--version',
      '1.0.40',
      '--tag',
      'latest',
      '--package',
      'k-vtable',
      '--otp',
      '123456'
    ]).otp,
    '123456'
  );
});

test('parseCliArgs supports stage inspection and approval commands', () => {
  assert.deepEqual(parseCliArgs(['stages', '--registry', 'https://registry.example.test/']), {
    command: 'stages',
    version: undefined,
    registry: 'https://registry.example.test/',
    tag: undefined,
    otp: undefined,
    stageId: undefined,
    package: undefined,
    stage: false,
    approve: false,
    skipBuild: false
  });
  assert.equal(
    parseCliArgs(['stage-approve', '--version', '1.0.48', '--stage-id', 'stage-uuid', '--otp', '123456']).stageId,
    'stage-uuid'
  );
  assert.throws(() => parseCliArgs(['stage-approve', '--version', '1.0.48']), /--stage-id/);
  assert.throws(() => parseCliArgs(['stages', '--version', '1.0.48']), /--registry/);
});

test('parseCliArgs models staged publish and deferred approval', () => {
  const staged = parseCliArgs([
    'publish',
    '--version',
    '1.0.48',
    '--tag',
    'latest',
    '--package',
    'k-vtable',
    '--stage'
  ]);
  assert.equal(staged.stage, true);
  assert.equal(staged.approve, false);

  assert.equal(
    parseCliArgs([
      'publish',
      '--version',
      '1.0.48',
      '--tag',
      'latest',
      '--package',
      'k-vtable',
      '--stage',
      '--approve'
    ]).approve,
    true
  );

  assert.throws(
    () => parseCliArgs(['publish', '--version', '1.0.48', '--tag', 'latest', '--package', 'k-vtable', '--approve']),
    /--approve requires --stage/
  );
  assert.throws(() => parseCliArgs(['pack', '--version', '1.0.48', '--stage']), /--stage is only supported by publish/);
  assert.throws(
    () => parseCliArgs(['stage-approve', '--version', '1.0.48', '--stage-id', 'x', '--stage']),
    /does not accept --stage/
  );
});

test('parseNpmErrorCode reads the first npm error code from output', () => {
  assert.equal(parseNpmErrorCode('npm error code E409\nnpm error 409 Conflict'), 'E409');
  assert.equal(parseNpmErrorCode('npm error code E404'), 'E404');
  assert.equal(parseNpmErrorCode('npm error code EPERM'), 'EPERM');
  assert.equal(parseNpmErrorCode('npm error code EACCES\npath /Users/x/.npm/_cacache/tmp'), 'EACCES');
  assert.equal(parseNpmErrorCode('all good'), undefined);
  assert.equal(parseNpmErrorCode(undefined), undefined);
  assert.equal(parseNpmErrorCode('open /tmp/EROFS-cache/index.js'), undefined);
});

test('isEnvironmentErrorCode separates host failures from registry state', () => {
  assert.equal(isEnvironmentErrorCode('EPERM'), true);
  assert.equal(isEnvironmentErrorCode('eacces'), true);
  assert.equal(isEnvironmentErrorCode('E404'), false);
  assert.equal(isEnvironmentErrorCode('E409'), false);
  assert.equal(isEnvironmentErrorCode(undefined), false);
});

test('isStageConflictError only matches the staged-version conflict', () => {
  const conflict = new Error(
    [
      'Command failed (1): npm publish',
      'npm error code E409',
      'npm error 409 Conflict - PUT https://registry.npmjs.org/k-vtable',
      'npm error Cannot publish over previously staged version "1.0.48".'
    ].join('\n')
  );
  assert.equal(isStageConflictError(conflict), true);
  const duplicate = new Error('npm error code E409\nCannot publish over previously published version');
  assert.equal(isStageConflictError(duplicate), false);
  const missing = new Error('npm error code E404');
  assert.equal(isStageConflictError(missing), false);
});

test('findStagedVersions and formatStageConflictHelp point at the blocking stage', () => {
  const staged = [
    { id: 'stage-1', name: 'k-vtable', version: '1.0.48', createdAt: '2026-10-09T10:50:00.000Z', actor: 'someone' },
    { id: 'stage-2', name: 'k-vtable', version: '1.0.47' },
    { id: 'stage-3', name: 'k-react-vtable', version: '1.0.48' }
  ];

  assert.deepEqual(
    findStagedVersions(staged, 'k-vtable', '1.0.48').map(item => item.id),
    ['stage-1']
  );
  const help = formatStageConflictHelp({ packageName: 'k-vtable', version: '1.0.48', stagedItems: staged });
  assert.match(help, /暂存/);
  assert.match(help, /stage-approve --stage-id stage-1 --version 1\.0\.48/);
  assert.match(help, /npm stage download stage-1/);
  assert.match(help, /npm stage reject stage-1/);

  const withoutMatch = formatStageConflictHelp({ packageName: 'k-vtable', version: '1.0.50', stagedItems: staged });
  assert.match(withoutMatch, /k-vtable \/ 1\.0\.48 \/ stage-1/);
  const empty = formatStageConflictHelp({ packageName: 'k-vtable', version: '1.0.50', stagedItems: [] });
  assert.match(empty, /npm stage list k-vtable/);
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

test('runProcess exposes npm error codes to callers', async () => {
  await assert.rejects(
    runProcess(process.execPath, ['-e', 'process.stderr.write("npm error code EPERM\\n"); process.exit(1)']),
    error => {
      assert.equal(error.exitCode, 1);
      assert.equal(error.npmErrorCode, 'EPERM');
      assert.equal(isEnvironmentErrorCode(error.npmErrorCode), true);
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

test('parseCliArgs requires a target package for publish', () => {
  assert.throws(() => parseCliArgs(['publish', '--version', '1.0.40', '--tag', 'latest']), /--package/);
  assert.throws(
    () => parseCliArgs(['publish', '--version', '1.0.40', '--tag', 'latest', '--package', 'k-something']),
    /--package must be one of/
  );
  assert.throws(
    () => parseCliArgs(['pack', '--version', '1.0.40', '--package', 'k-vtable']),
    /--package is not supported by pack/
  );
  assert.equal(
    parseCliArgs(['publish', '--version', '1.0.40', '--tag', 'latest', '--package', 'k-react-vtable']).package,
    'k-react-vtable'
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

async function createPublishFixture(t) {
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
  return { repoRoot, corePath, reactPath };
}

function createPublishRunner() {
  const published = new Set();
  const commands = [];
  const runProcess = async (command, args) => {
    assert.equal(command, 'npm');
    commands.push(args);
    if (args[0] === 'whoami') {
      return { stdout: 'publisher\n', stderr: '', code: 0 };
    }
    if (args[0] === 'view') {
      const packageName = args[1].split('@2.0.0')[0];
      if (!published.has(packageName)) {
        const error = new Error('npm ERR! code E404');
        error.npmErrorCode = 'E404';
        throw error;
      }      const integrity = packageName === 'k-vtable' ? 'sha512-core' : 'sha512-react';
      return { stdout: JSON.stringify({ version: '2.0.0', dist: { integrity } }), stderr: '', code: 0 };
    }
    if (args[0] === 'publish') {
      published.add(path.basename(args[1]).startsWith('k-react') ? 'k-react-vtable' : 'k-vtable');
      return { stdout: 'published', stderr: '', code: 0 };
    }
    throw new Error(`Unexpected npm command: ${args.join(' ')}`);
  };
  return { published, commands, runProcess };
}

test('publish --package k-vtable publishes only the core tarball and records its state', async t => {
  const { repoRoot } = await createPublishFixture(t);
  const { commands, runProcess } = createPublishRunner();

  const result = await publishRelease(
    {
      version: '2.0.0',
      tag: 'latest',
      registry: 'https://registry.example.test/',
      package: 'k-vtable'
    },
    { repoRoot, getGitCommit: async () => 'abc123', runProcess, wait: async () => {} }
  );

  assert.equal(result.packageName, 'k-vtable');
  assert.equal(result.published, true);
  const publishCommands = commands.filter(args => args[0] === 'publish');
  assert.equal(publishCommands.length, 1);
  assert.equal(path.basename(publishCommands[0][1]), 'k-vtable-2.0.0.tgz');
  assert.equal(publishCommands[0].includes('https://registry.example.test/'), true);
  assert.equal(commands.some(args => args[1]?.startsWith?.('k-react-vtable@')), false);

  const publishedState = JSON.parse(
    await fs.readFile(path.join(repoRoot, 'artifacts', 'k-release-2.0.0-k-vtable.published.json'))
  );
  assert.equal(publishedState.packageName, 'k-vtable');
  assert.equal(publishedState.tarball.integrity, 'sha512-core');
  assert.equal(publishedState.sourceCommit, 'abc123');
  const pendingReactState = path.join(repoRoot, 'artifacts', 'k-release-2.0.0-k-react-vtable.published.json');
  await assert.rejects(fs.access(pendingReactState), /ENOENT/);
});

test('publish --package k-react-vtable publishes only the React tarball', async t => {
  const { repoRoot } = await createPublishFixture(t);
  const { commands, runProcess } = createPublishRunner();

  const result = await publishRelease(
    { version: '2.0.0', tag: 'latest', package: 'k-react-vtable' },
    { repoRoot, getGitCommit: async () => 'abc123', runProcess, wait: async () => {} }
  );

  assert.equal(result.packageName, 'k-react-vtable');
  const publishCommands = commands.filter(args => args[0] === 'publish');
  assert.equal(publishCommands.length, 1);
  assert.equal(path.basename(publishCommands[0][1]), 'k-react-vtable-2.0.0.tgz');
  const publishedState = JSON.parse(
    await fs.readFile(path.join(repoRoot, 'artifacts', 'k-release-2.0.0-k-react-vtable.published.json'))
  );
  assert.equal(publishedState.tarball.integrity, 'sha512-react');
});

test('re-running publish for an already published package is a no-op success', async t => {
  const { repoRoot } = await createPublishFixture(t);
  const { commands, runProcess } = createPublishRunner();
  const dependencies = { repoRoot, getGitCommit: async () => 'abc123', runProcess, wait: async () => {} };

  await publishRelease({ version: '2.0.0', tag: 'latest', package: 'k-vtable' }, dependencies);
  const publishedAt = JSON.parse(
    await fs.readFile(path.join(repoRoot, 'artifacts', 'k-release-2.0.0-k-vtable.published.json'))
  ).publishedAt;

  const second = await publishRelease({ version: '2.0.0', tag: 'latest', package: 'k-vtable' }, dependencies);

  assert.equal(second.published, false);
  assert.equal(second.reason, 'already published with the same integrity');
  assert.equal(commands.filter(args => args[0] === 'publish').length, 1);
  const reRead = JSON.parse(
    await fs.readFile(path.join(repoRoot, 'artifacts', 'k-release-2.0.0-k-vtable.published.json'))
  );
  assert.equal(reRead.publishedAt, publishedAt);
});

function createStagedRunner({ stageId = 'stage-uuid-1', publishedIntegrity = 'sha512-core' } = {}) {
  const commands = [];
  let approved = false;
  const runProcess = async (command, args) => {
    assert.equal(command, 'npm');
    commands.push(args);
    if (args[0] === 'whoami') {
      return { stdout: 'publisher\n', stderr: '', code: 0 };
    }
    if (args[0] === '--version') {
      return { stdout: '11.19.0\n', stderr: '', code: 0 };
    }
    if (args[0] === 'view') {
      if (!approved) {
        const error = new Error('npm ERR! code E404');
        error.npmErrorCode = 'E404';
        throw error;
      }
      return { stdout: JSON.stringify({ version: '2.0.0', dist: { integrity: publishedIntegrity } }), stderr: '' };
    }
    if (args[0] === 'stage' && args[1] === 'publish') {
      return {
        stdout: JSON.stringify({
          'k-vtable': { name: 'k-vtable', version: '2.0.0', integrity: 'sha512-core', stageId }
        }),
        stderr: ''
      };
    }
    if (args[0] === 'stage' && args[1] === 'view') {
      return {
        stdout: JSON.stringify({
          id: stageId,
          packageName: 'k-vtable',
          version: '2.0.0',
          tag: 'latest',
          shasum: 'sha-core'
        }),
        stderr: ''
      };
    }
    if (args[0] === 'stage' && args[1] === 'approve') {
      approved = true;
      return { stdout: `Staged package ${args[2]} approved and published successfully.`, stderr: '' };
    }
    throw new Error(`Unexpected npm command: ${args.join(' ')}`);
  };
  return { commands, runProcess };
}

test('publish --stage stages the tarball and defers approval', async t => {
  const { repoRoot } = await createPublishFixture(t);
  const { commands, runProcess } = createStagedRunner();

  const result = await publishRelease(
    { version: '2.0.0', tag: 'latest', package: 'k-vtable', stage: true },
    { repoRoot, getGitCommit: async () => 'abc123', runProcess, wait: async () => {} }
  );

  assert.equal(result.staged, true);
  assert.equal(result.published, false);
  assert.equal(result.stageId, 'stage-uuid-1');
  assert.match(result.next, /stage-approve --stage-id stage-uuid-1/);
  assert.equal(commands.some(args => args[0] === 'publish'), false);
  assert.equal(commands.some(args => args[1] === 'approve'), false);
  assert.equal(commands.some(args => args[0] === '--version'), true);

  const statePath = path.join(repoRoot, 'artifacts', 'k-release-2.0.0-k-vtable.published.json');
  await assert.rejects(fs.access(statePath), /ENOENT/);
});

test('publish --stage --approve stages then approves with OTP', async t => {
  const { repoRoot } = await createPublishFixture(t);
  const { commands, runProcess } = createStagedRunner();

  const result = await publishRelease(
    { version: '2.0.0', tag: 'latest', package: 'k-vtable', stage: true, approve: true, otp: '123456' },
    { repoRoot, getGitCommit: async () => 'abc123', runProcess, wait: async () => {} }
  );

  assert.equal(result.staged, true);
  assert.equal(result.published, true);
  const approveCall = commands.find(args => args[1] === 'approve');
  assert.deepEqual(approveCall, ['stage', 'approve', 'stage-uuid-1', '--otp', '123456']);
  const state = JSON.parse(
    await fs.readFile(path.join(repoRoot, 'artifacts', 'k-release-2.0.0-k-vtable.published.json'))
  );
  assert.equal(state.stagedVia, 'npm stage publish + stage approve');
});

test('publish --stage refuses an npm older than the staged publishing floor', async t => {
  const { repoRoot } = await createPublishFixture(t);
  const runProcess = async (command, args) => {
    if (args[0] === 'whoami') {
      return { stdout: 'publisher\n', stderr: '', code: 0 };
    }
    if (args[0] === 'view') {
      const error = new Error('npm ERR! code E404');
      error.npmErrorCode = 'E404';
      throw error;
    }
    if (args[0] === '--version') {
      return { stdout: '11.14.0\n', stderr: '', code: 0 };
    }
    throw new Error(`Unexpected npm command: ${args.join(' ')}`);
  };

  await assert.rejects(
    publishRelease(
      { version: '2.0.0', tag: 'latest', package: 'k-vtable', stage: true },
      { repoRoot, getGitCommit: async () => 'abc123', runProcess, wait: async () => {} }
    ),
    /npm 11\.15\.0/
  );
});

test('publish refuses to overwrite a version whose registry integrity differs', async t => {
  const { repoRoot } = await createPublishFixture(t);
  const runProcess = async (command, args) => {
    if (args[0] === 'whoami') {
      return { stdout: 'publisher\n', stderr: '', code: 0 };
    }
    if (args[0] === 'view') {
      return { stdout: JSON.stringify({ version: '2.0.0', dist: { integrity: 'sha512-other' } }), stderr: '' };
    }
    throw new Error(`Unexpected npm command: ${args.join(' ')}`);
  };

  await assert.rejects(
    publishRelease(
      { version: '2.0.0', tag: 'latest', package: 'k-vtable' },
      { repoRoot, getGitCommit: async () => 'abc123', runProcess, wait: async () => {} }
    ),
    /integrity/
  );
});

test('parsePublishedViewResult accepts both npm 11 object and npm 12 array output', () => {
  assert.deepEqual(
    parsePublishedViewResult('{"version":"1.0.48","dist.integrity":"sha512-object"}', 'k-vtable', '1.0.48'),
    { version: '1.0.48', integrity: 'sha512-object' }
  );
  assert.deepEqual(
    parsePublishedViewResult('[{"version":"1.0.48","dist.integrity":"sha512-array"}]', 'k-vtable', '1.0.48'),
    { version: '1.0.48', integrity: 'sha512-array' }
  );
  assert.deepEqual(
    parsePublishedViewResult('[{"version":"1.0.48","dist":{"integrity":"sha512-nested"}}]', 'k-vtable', '1.0.48'),
    { version: '1.0.48', integrity: 'sha512-nested' }
  );
  assert.throws(() => parsePublishedViewResult('[]', 'k-vtable', '1.0.48'), /no usable result/i);
  assert.throws(() => parsePublishedViewResult('[{"version":"1.0.48"}]', 'k-vtable', '1.0.48'), /dist\.integrity/);
  assert.throws(() => parsePublishedViewResult('not json', 'k-vtable', '1.0.48'), /unparsable JSON/i);
});

test('publishRelease explains an environment failure instead of blaming the version', async t => {
  const repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'k-release-publish-env-'));
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
        'k-vtable': { filename: path.basename(corePath), path: corePath, integrity: 'sha512-core', shasum: 'sha-core' },
        'k-react-vtable': {
          filename: path.basename(reactPath),
          path: reactPath,
          integrity: 'sha512-react',
          shasum: 'sha-react'
        }
      }
    })
  );

  const fakeRunProcess = async (command, args) => {
    if (args[0] === 'whoami') {
      const error = new Error('Command failed (1): npm whoami\nnpm error code EPERM\nnpm error path /Users/x/.npm');
      error.npmErrorCode = 'EPERM';
      throw error;
    }
    throw new Error(`Unexpected npm command: ${args.join(' ')}`);
  };

  await assert.rejects(
    publishRelease(
      { version: '2.0.0', tag: 'latest', package: 'k-vtable' },
      { repoRoot, getGitCommit: async () => 'abc123', runProcess: fakeRunProcess, wait: async () => {} }
    ),
    error => {
      assert.equal(error.npmErrorCode, 'EPERM');
      assert.match(error.message, /环境故障/);
      assert.match(error.message, /不要靠递增版本号绕过/);
      return true;
    }
  );
});

function stageConflict(packageName, version) {
  const error = new Error(
    `Command failed (1): npm publish\nnpm error code E409\nnpm error 409 Conflict - PUT https://registry.npmjs.org/${packageName} - Cannot publish over previously staged version "${version}".`
  );
  error.npmErrorCode = 'E409';
  return error;
}

test('assertStagedPublishingSupport enforces the documented npm and Node floors', () => {
  assert.doesNotThrow(() => assertStagedPublishingSupport('11.19.0', '22.14.0'));
  assert.doesNotThrow(() => assertStagedPublishingSupport('12.2.0', '24.0.0'));
  assert.doesNotThrow(() => assertStagedPublishingSupport('11.15.0', '22.14.0'));
  assert.throws(() => assertStagedPublishingSupport('11.14.0', '22.14.0'), /npm 11\.15\.0/);
  assert.throws(() => assertStagedPublishingSupport('10.8.2', '22.14.0'), /npm 11\.15\.0/);
  assert.throws(() => assertStagedPublishingSupport('11.19.0', '20.11.0'), /Node 22\.14\.0/);
  assert.throws(() => assertStagedPublishingSupport('', '22.14.0'), /npm 11\.15\.0/);
});

test('stageTarball stages the tarball with --json and rejects an integrity mismatch', async () => {
  const commands = [];
  const execute = async (command, args) => {
    commands.push(args);
    if (args[0] === 'stage' && args[1] === 'publish') {
      return {
        stdout: JSON.stringify({
          'k-vtable': {
            id: 'k-vtable@2.0.0',
            name: 'k-vtable',
            version: '2.0.0',
            integrity: 'sha512-core',
            stageId: 'stage-uuid-core'
          }
        }),
        stderr: ''
      };
    }
    throw new Error(`Unexpected command: ${args.join(' ')}`);
  };

  await assert.rejects(
    stageTarball({
      execute,
      packageName: 'k-vtable',
      version: '2.0.0',
      tarball: { path: '/tmp/k-vtable-2.0.0.tgz', integrity: 'sha512-other', cwd: '/tmp' },
      tag: 'latest'
    }),
    /integrity mismatch/i
  );

  const staged = await stageTarball({
    execute,
    packageName: 'k-vtable',
    version: '2.0.0',
    tarball: { path: '/tmp/k-vtable-2.0.0.tgz', integrity: 'sha512-core', cwd: '/tmp' },
    tag: 'latest'
  });

  const stagePublish = commands.find(args => args[1] === 'publish');
  assert.deepEqual(stagePublish, ['stage', 'publish', '/tmp/k-vtable-2.0.0.tgz', '--tag', 'latest', '--json']);
  assert.equal(staged.stageId, 'stage-uuid-core');
  assert.equal(staged.approved, false);
});

test('stageTarball surfaces npm stage publish JSON stage ids', async () => {
  const execute = async (command, args) => {
    if (args[0] === 'stage' && args[1] === 'publish') {
      return {
        stdout: JSON.stringify({
          'k-react-vtable': {
            id: 'k-react-vtable@2.0.0',
            name: 'k-react-vtable',
            version: '2.0.0',
            integrity: 'sha512-react',
            stageId: '0199-uuid'
          }
        }),
        stderr: ''
      };
    }
    throw new Error(`Unexpected command: ${args.join(' ')}`);
  };

  const staged = await stageTarball({
    execute,
    packageName: 'k-react-vtable',
    version: '2.0.0',
    tarball: { path: '/tmp/k-react-vtable-2.0.0.tgz', integrity: 'sha512-react', cwd: '/tmp' },
    tag: 'latest'
  });

  assert.equal(staged.stageId, '0199-uuid');
  assert.equal(staged.approved, false);
});

test('stageTarball falls back to stage list when npm omits the stage id', async () => {
  const execute = async (command, args) => {
    if (args[0] === 'stage' && args[1] === 'publish') {
      return {
        stdout: JSON.stringify({ 'k-vtable': { name: 'k-vtable', version: '2.0.0', integrity: 'sha512-core' } }),
        stderr: ''
      };
    }
    if (args[0] === 'stage' && args[1] === 'list') {
      return {
        stdout: JSON.stringify([{ id: 'listed-uuid', packageName: 'k-vtable', version: '2.0.0' }]),
        stderr: ''
      };
    }
    throw new Error(`Unexpected command: ${args.join(' ')}`);
  };

  const staged = await stageTarball({
    execute,
    packageName: 'k-vtable',
    version: '2.0.0',
    tarball: { path: '/tmp/k-vtable-2.0.0.tgz', integrity: 'sha512-core', cwd: '/tmp' },
    tag: 'latest'
  });

  assert.equal(staged.stageId, 'listed-uuid');
});

test('listStagedVersions reports a real npm failure with context', async () => {
  const execute = async () => {
    const error = new Error('Command failed (1): npm stage list\nnpm error code E403');
    error.npmErrorCode = 'E403';
    throw error;
  };
  await assert.rejects(listStagedVersions({}, { runProcess: execute }), error => {
    assert.match(error.message, /npm stage list 失败/);
    return true;
  });
});

test('publishTarball treats an E409 as success when the registry already has the same integrity', async () => {
  const commands = [];
  let publishAttempts = 0;
  const execute = async (command, args) => {
    commands.push(args);
    if (args[0] === 'publish') {
      publishAttempts++;
      throw stageConflict('k-vtable', '2.0.0');
    }
    if (args[0] === 'view') {
      return { stdout: JSON.stringify({ version: '2.0.0', dist: { integrity: 'sha512-core' } }), stderr: '' };
    }
    throw new Error(`Unexpected command: ${args.join(' ')}`);
  };

  const published = await publishTarball({
    execute,
    packageName: 'k-vtable',
    version: '2.0.0',
    tarball: { path: '/tmp/k-vtable-2.0.0.tgz', integrity: 'sha512-core', cwd: '/tmp' },
    tag: 'latest',
    registry: undefined,
    wait: async () => {}
  });

  assert.equal(publishAttempts, 1);
  assert.equal(published.integrity, 'sha512-core');
  assert.equal(commands.some(args => args[0] === 'stage'), false);
});

test('publishTarball reports staged versions instead of a bare E409', async () => {
  const execute = async (command, args) => {
    if (args[0] === 'publish') {
      throw stageConflict('k-vtable', '2.0.0');
    }
    if (args[0] === 'view') {
      const error = new Error('npm error code E404');
      error.npmErrorCode = 'E404';
      throw error;
    }
    if (args[0] === 'stage' && args[1] === 'list') {
      return {
        stdout: JSON.stringify([
          { id: 'stage-uuid-1', packageName: 'k-vtable', version: '2.0.0', createdAt: '2026-10-09T10:50:00.000Z', actor: 'mate' }
        ]),
        stderr: ''
      };
    }
    throw new Error(`Unexpected command: ${args.join(' ')}`);
  };

  await assert.rejects(
    publishTarball({
      execute,
      packageName: 'k-vtable',
      version: '2.0.0',
      tarball: { path: '/tmp/k-vtable-2.0.0.tgz', integrity: 'sha512-core', cwd: '/tmp' },
      tag: 'latest',
      registry: undefined,
      wait: async () => {}
    }),
    error => {
      assert.match(error.message, /stage-uuid-1/);
      assert.match(error.message, /stage-approve --stage-id/);
      return true;
    }
  );
});

test('publishTarball stops when the published integrity differs from the local tarball', async () => {
  const execute = async (command, args) => {
    if (args[0] === 'publish') {
      throw stageConflict('k-vtable', '2.0.0');
    }
    if (args[0] === 'view') {
      return { stdout: JSON.stringify({ version: '2.0.0', dist: { integrity: 'sha512-other' } }), stderr: '' };
    }
    throw new Error(`Unexpected command: ${args.join(' ')}`);
  };

  await assert.rejects(
    publishTarball({
      execute,
      packageName: 'k-vtable',
      version: '2.0.0',
      tarball: { path: '/tmp/k-vtable-2.0.0.tgz', integrity: 'sha512-core', cwd: '/tmp' },
      tag: 'latest',
      registry: undefined,
      wait: async () => {}
    }),
    /integrity/i
  );
});

test('approveStagedRelease approves the stage id and verifies publication', async () => {
  const commands = [];
  const execute = async (command, args) => {
    commands.push(args);
    if (args[0] === 'stage' && args[1] === 'approve') {
      return { stdout: '', stderr: '' };
    }
    if (args[0] === 'stage' && args[1] === 'view') {
      return {
        stdout: JSON.stringify({ id: 'stage-uuid-1', packageName: 'k-vtable', version: '1.0.48' }),
        stderr: ''
      };
    }
    if (args[0] === 'view') {
      return { stdout: JSON.stringify({ version: '1.0.48', dist: { integrity: 'sha512-core' } }), stderr: '' };
    }
    throw new Error(`Unexpected command: ${args.join(' ')}`);
  };

  const result = await approveStagedRelease(
    { stageId: 'stage-uuid-1', version: '1.0.48', otp: '123456', registry: 'https://registry.example.test/' },
    { runProcess: execute, wait: async () => {} }
  );

  assert.equal(result.stageId, 'stage-uuid-1');
  assert.equal(result.version, '1.0.48');
  assert.equal(result.packageName, 'k-vtable');
  const approveCall = commands.find(args => args[1] === 'approve');
  assert.deepEqual(approveCall, [
    'stage',
    'approve',
    'stage-uuid-1',
    '--otp',
    '123456',
    '--registry',
    'https://registry.example.test/'
  ]);
  await assert.rejects(approveStagedRelease({ version: '1.0.48' }), /stage id/i);
});

test('approveStagedRelease refuses to approve when --version disagrees with the stage id', async () => {
  const commands = [];
  const execute = async (command, args) => {
    commands.push(args);
    if (args[0] === 'stage' && args[1] === 'view') {
      return {
        stdout: JSON.stringify({ id: 'stage-uuid-1', packageName: 'k-vtable', version: '1.0.50' }),
        stderr: ''
      };
    }
    throw new Error(`Unexpected command: ${args.join(' ')}`);
  };

  await assert.rejects(
    approveStagedRelease({ stageId: 'stage-uuid-1', version: '1.0.49' }, { runProcess: execute, wait: async () => {} }),
    error => {
      assert.match(error.message, /k-vtable@1\.0\.50/);
      assert.match(error.message, /与 --version 1\.0\.49 不一致/);
      assert.match(error.message, /已中止 approve/);
      return true;
    }
  );
  assert.equal(
    commands.some(args => args[1] === 'approve'),
    false,
    'approve must not run when the version check fails'
  );
});

test('approveStagedRelease reports a stale stage id instead of a bare npm error', async () => {
  const execute = async (command, args) => {
    if (args[0] === 'stage' && args[1] === 'view') {
      const error = new Error('npm error code E404');
      error.npmErrorCode = 'E404';
      throw error;
    }
    throw new Error(`Unexpected command: ${args.join(' ')}`);
  };

  await assert.rejects(
    approveStagedRelease({ stageId: 'gone-uuid', version: '1.0.49' }, { runProcess: execute, wait: async () => {} }),
    error => {
      assert.match(error.message, /无法读取暂存条目 gone-uuid/);
      assert.match(error.message, /stages/);
      return true;
    }
  );
});
