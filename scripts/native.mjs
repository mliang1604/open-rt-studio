/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// Builds the native tools (native/README.md), the same way on a developer's
// machine and in CI, on Linux, macOS and Windows.
//
//   node scripts/native.mjs deps [--only itk] [--prune]
//       ITK and elastix, from their pinned sources. Long (an hour or more
//       the first time); a second run finds them built and does nothing.
//       --only itk stops after ITK. --prune removes what only the build of
//       them needed, for a folder that is kept between CI runs.
//   node scripts/native.mjs build
//       The tools, into <build>/dist (bin/ and licenses/).
//   node scripts/native.mjs test
//       The tools' tests (CTest).
//   node scripts/native.mjs where
//       Prints the folders it uses, as JSON.
//
// It needs CMake 3.24 or newer and a C++17 compiler; Ninja is used when it
// is there. Settings, all optional:
//
//   ORS_NATIVE_BUILD_DIR   where everything is built (native/build). On
//                          Windows a short path is wanted: ITK refuses a
//                          long one.
//   ORS_NATIVE_ARCH        macOS only: arm64 or x86_64, to build for the
//                          other processor than this machine's.
//   ORS_NATIVE_JOBS        how many compilations at once (all processors).

import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, rmSync, statSync } from 'node:fs';
import { availableParallelism } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const NATIVE = join(ROOT, 'native');

/** The folders of a build, from where it is rooted. */
export function folders(buildDir) {
  return {
    build: buildDir,
    /** The build tree of ITK and elastix: only needed while they are built. */
    deps: join(buildDir, 'deps'),
    /** ITK installed, elastix where it was built, and their licences: what CI keeps. */
    prefix: join(buildDir, 'prefix'),
    /** The build tree of the tools. */
    tools: join(buildDir, 'tools'),
    /** The tools as they are handed on: bin/ and licenses/. */
    dist: join(buildDir, 'dist'),
  };
}

/** What a configure step is told beyond its folders, from the settings. */
export function configureArguments({ platform, arch, ninja }) {
  const told = ['-DCMAKE_BUILD_TYPE=Release'];
  if (ninja) told.unshift('-G', 'Ninja');
  if (platform === 'darwin' && arch) {
    if (arch !== 'arm64' && arch !== 'x86_64') {
      throw new Error(`ORS_NATIVE_ARCH is arm64 or x86_64, not ${arch}`);
    }
    told.push(`-DCMAKE_OSX_ARCHITECTURES=${arch}`);
  }
  return told;
}

/** Files that only a build needed: objects and the like, by their ending. */
export function isBuildLeftover(name) {
  return /\.(o|obj|pdb|ilk|tlog|lastbuildstate|d)$/i.test(name);
}

function run(command, args, options = {}) {
  console.log(`> ${command} ${args.join(' ')}`);
  const done = spawnSync(command, args, { stdio: 'inherit', ...options });
  if (done.error) throw done.error;
  if (done.status !== 0) {
    console.error(`${command} failed with status ${done.status}`);
    process.exit(done.status ?? 1);
  }
}

function has(command) {
  const tried = spawnSync(command, ['--version'], { stdio: 'ignore' });
  return !tried.error && tried.status === 0;
}

/** Remove build leftovers under a folder; returns how many files went. */
function prune(folder) {
  let removed = 0;
  if (!existsSync(folder)) return removed;
  for (const name of readdirSync(folder)) {
    const path = join(folder, name);
    const what = statSync(path);
    if (what.isDirectory()) removed += prune(path);
    else if (isBuildLeftover(name)) {
      rmSync(path);
      removed += 1;
    }
  }
  return removed;
}

function main(argv) {
  const [command, ...rest] = argv;
  const flags = new Set(rest.filter((one) => one.startsWith('--')));
  const only = rest.includes('--only') ? rest[rest.indexOf('--only') + 1] : null;
  const at = folders(resolve(process.env['ORS_NATIVE_BUILD_DIR'] || join(NATIVE, 'build')));
  const jobs = String(Number(process.env['ORS_NATIVE_JOBS']) || availableParallelism());
  // On Windows Ninja is only right inside a Visual Studio command prompt:
  // elsewhere CMake would find another compiler than the one that is meant.
  const ninja = has('ninja') && (process.platform !== 'win32' || !!process.env['VCINSTALLDIR']);
  const configure = configureArguments({
    platform: process.platform,
    arch: process.env['ORS_NATIVE_ARCH'] || '',
    ninja,
  });
  // Visual Studio compiles one file at a time unless it is told otherwise.
  const env = { ...process.env, CMAKE_BUILD_PARALLEL_LEVEL: jobs };
  if (process.platform === 'win32' && !ninja) env['CL'] = `/MP ${process.env['CL'] ?? ''}`.trim();

  switch (command) {
    case 'where':
      console.log(JSON.stringify(at));
      return;
    case 'deps': {
      if (only !== null && only !== 'itk') throw new Error('--only takes itk');
      run(
        'cmake',
        ['-S', join(NATIVE, 'deps'), '-B', at.deps, `-DCMAKE_INSTALL_PREFIX=${at.prefix}`].concat(
          configure,
        ),
        { env },
      );
      const target = only === 'itk' ? ['--target', 'itk'] : [];
      run('cmake', ['--build', at.deps, '--config', 'Release', ...target], { env });
      if (flags.has('--prune')) {
        // ITK is installed, so its build tree can go; elastix is used from
        // where it was built, so only its objects go.
        rmSync(join(at.deps, 'itk-bld'), { recursive: true, force: true });
        rmSync(join(at.deps, 'itk-src'), { recursive: true, force: true });
        const removed = prune(join(at.prefix, 'elastix', 'build'));
        console.log(`pruned ${removed} files`);
      }
      return;
    }
    case 'build':
      run(
        'cmake',
        [
          '-S',
          NATIVE,
          '-B',
          at.tools,
          `-DORS_DEPS_PREFIX=${at.prefix}`,
          `-DCMAKE_INSTALL_PREFIX=${at.dist}`,
        ].concat(configure),
        { env },
      );
      run('cmake', ['--build', at.tools, '--config', 'Release'], { env });
      rmSync(at.dist, { recursive: true, force: true });
      run('cmake', ['--install', at.tools, '--config', 'Release'], { env });
      return;
    case 'test':
      run('ctest', ['--test-dir', at.tools, '-C', 'Release', '--output-on-failure'], { env });
      return;
    default:
      console.error(
        'usage: node scripts/native.mjs deps [--only itk] [--prune] | build | test | where',
      );
      process.exit(2);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2));
}
