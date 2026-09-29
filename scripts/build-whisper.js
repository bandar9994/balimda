// Balimda — © 2026 Bandar Altariqi. All rights reserved.
// Licensed under the Balimda License (see LICENSE): non-commercial use only;
// keep the Balimda name and the "Balimda by Bandar Altariqi" credit; no rebranding.

// Builds whisper.cpp's server (speech recognition for voice chat in the
// desktop app, see src/voice-desktop.js) into whisper-bin/<os>-<arch>/,
// which electron-builder packs into the app (package.json, extraResources).
//   node scripts/build-whisper.js
// Needs git, CMake and a C++ compiler (Visual Studio on Windows, Xcode on Mac).
//
// Windows and Linux: every CPU variant is built and the fastest one the
// computer supports is picked when it runs. Mac: Apple Silicon uses the GPU
// (Metal); Intel Macs are built too (on the same machine) for the Intel .dmg.

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const WHISPER_TAG = 'v1.9.4';
const root = path.join(__dirname, '..');
const src = path.join(root, 'build', `whisper.cpp-${WHISPER_TAG}`);
const osName = { win32: 'win', darwin: 'mac', linux: 'linux' }[process.platform];

const run = (cmd, args, opts = {}) => {
  console.log(`> ${cmd} ${args.join(' ')}`);
  execFileSync(cmd, args, { stdio: 'inherit', ...opts });
};

if (!fs.existsSync(path.join(src, 'CMakeLists.txt'))) {
  fs.rmSync(src, { recursive: true, force: true });
  run('git', ['clone', '--depth', '1', '--branch', WHISPER_TAG, 'https://github.com/ggml-org/whisper.cpp', src]);
}

const common = [
  '-DCMAKE_BUILD_TYPE=Release',
  '-DWHISPER_BUILD_TESTS=OFF',
  '-DWHISPER_BUILD_EXAMPLES=ON',
  '-DWHISPER_BUILD_SERVER=ON',
  '-DWHISPER_SDL2=OFF',
  '-DWHISPER_CURL=OFF',
  '-DGGML_NATIVE=OFF'
];

function build(arch, flags) {
  const dir = path.join(root, 'build', `whisper-${osName}-${arch}`);
  run('cmake', ['-S', src, '-B', dir, ...common, ...flags]);
  run('cmake', ['--build', dir, '--config', 'Release', '--target', 'whisper-server', '-j', '4']);

  const bin = [path.join(dir, 'bin', 'Release'), path.join(dir, 'bin')].find((d) => fs.existsSync(d));
  const out = path.join(root, 'whisper-bin', `${osName}-${arch}`);
  fs.rmSync(out, { recursive: true, force: true });
  fs.mkdirSync(out, { recursive: true });
  // The server, and the libraries it loads (copied, not linked: links don't survive packaging).
  const keep = (name) => name === 'whisper-server' || name === 'whisper-server.exe' ||
    /\.dll$/i.test(name) || /\.so\.\d+$/.test(name) || /^libggml-(?!base\.so$)[\w-]+\.so$/.test(name);
  for (const name of fs.readdirSync(bin)) {
    if (!keep(name)) continue;
    fs.copyFileSync(path.join(bin, name), path.join(out, name));
    fs.chmodSync(path.join(out, name), 0o755);
  }
  console.log(`whisper-bin/${osName}-${arch}:`, fs.readdirSync(out).join(', '));
  if (!fs.readdirSync(out).some((n) => n.startsWith('whisper-server'))) throw new Error('whisper-server was not built');
}

if (osName === 'mac') {
  const mac = ['-DBUILD_SHARED_LIBS=OFF', '-DCMAKE_OSX_DEPLOYMENT_TARGET=11.0', '-DGGML_METAL_EMBED_LIBRARY=ON', '-DGGML_BLAS=OFF'];
  build('arm64', [...mac, '-DCMAKE_OSX_ARCHITECTURES=arm64', '-DGGML_METAL=ON']);
  build('x64', [...mac, '-DCMAKE_OSX_ARCHITECTURES=x86_64', '-DCMAKE_SYSTEM_PROCESSOR=x86_64', '-DGGML_METAL=OFF']);
} else {
  const shared = ['-DBUILD_SHARED_LIBS=ON', '-DGGML_BACKEND_DL=ON', '-DGGML_CPU_ALL_VARIANTS=ON'];
  if (osName === 'win') shared.push('-DCMAKE_MSVC_RUNTIME_LIBRARY=MultiThreaded');
  if (osName === 'linux') shared.push('-DCMAKE_BUILD_RPATH=$ORIGIN', '-DCMAKE_INSTALL_RPATH=$ORIGIN');
  build(process.arch, shared);
}
