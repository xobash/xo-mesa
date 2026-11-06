import { createHash } from "node:crypto";
// The real wrapper executes against isolated fake Git/launcher commands. No installs or network.
import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
const folders = [];
// Synthetic `git verify-tag --raw` lines; fingerprints are joined from fragments.
const pinnedFingerprint = ['SHA256', 'JTK3hA6m0Hr2/77nrt0wTl0n38Lrl8HuraqKbvZd3so'].join(':');
const foreignFingerprint = ['SHA256', 'heOwUFRozvdEk4SCyDUZHIS3van9fJdZ+aTvrWbROUk'].join(':');
const sshGood = (principal, fingerprint) => ['Good "git" signature for', principal, 'with ED25519', 'key', fingerprint].join(' ');
const pinnedSignature = sshGood('xobash@users.noreply.github.com', pinnedFingerprint);
afterEach(() => { for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true }); });
function fixture(existing = true) {
  const root = mkdtempSync(join(tmpdir(), 'mesa-installer-test-')); folders.push(root);
  const bin = join(root, 'bin'), install = join(root, 'folder with spaces'); mkdirSync(bin);
  if (existing !== 'clone') mkdirSync(install);
  if (existing === true) mkdirSync(join(install, '.git'));
  writeFileSync(join(bin, 'git'), '#!/bin/bash\nprintf "%s\\n" "$*" >> "$TEST_LOG"\nif [[ "$1" == "clone" ]]; then mkdir -p "${@: -1}" && printf "#!/bin/bash\\nprintf \\"launched\\\\n\\" >> \\"\\$TEST_LOG\\"\\n" > "${@: -1}/run.sh"; fi\nif [[ "$*" == *"remote get-url origin"* ]]; then printf "%s\\n" "https://github.com/xobash/xo-mesa.git"; fi\nif [[ "$*" == *"verify-tag"* ]]; then for a in "$@"; do if [[ "$a" == gpg.ssh.allowedSignersFile=* ]]; then cat "${a#*=}" >> "$TEST_LOG"; fi; done; printf "%s\\n" "${TEST_SIGNATURE_OUTPUT-$PINNED_SIGNATURE}" >&2; if [[ "$TEST_SIGNATURE_FAIL" == "1" ]]; then exit 1; fi; fi\nif [[ "$*" == *"merge --ff-only"* && "$TEST_MERGE_FAIL" == "1" ]]; then exit 1; fi\nif [[ "$*" == *"rev-parse"* ]]; then if [[ "$*" == *" HEAD" && "$TEST_AHEAD" == "1" ]]; then printf "ahead\\n"; else printf "release\\n"; fi; fi\nexit "${TEST_GIT_EXIT:-0}"\n', { mode: 0o755 });
  if (existing !== 'clone') { writeFileSync(join(install, 'run.sh'), '#!/bin/bash\nprintf "launched\\n" >> "$TEST_LOG"\n'); writeFileSync(join(install, 'user-note.md'), 'keep me'); }
  return { root, install, run: (code = 0, overrides = {}) => spawnSync('/bin/bash', [resolve('install.sh')], { cwd: root, env: { ...process.env, MESA_DIR: install, PATH: `${bin}:${process.env.PATH}`, TEST_LOG: join(root, 'calls'), TEST_GIT_EXIT: String(code), PINNED_SIGNATURE: pinnedSignature, ...overrides }, encoding: 'utf8' }), log: () => { try { return readFileSync(join(root, 'calls'), 'utf8'); } catch { return ''; } } };
}
describe('one-command installer behavior', { skip: process.platform === 'win32' }, () => {
  it('updates then launches a folder containing spaces, and is repeatable', () => {
    const f = fixture(); assert.equal(f.run().status, 0); assert.equal(f.run().status, 0);
    assert.equal(f.log().match(/launched/g).length, 2); assert.match(f.log(), /merge --ff-only refs\/tags\/v0.1.0/);
    assert.equal(readFileSync(join(f.install, 'user-note.md'), 'utf8'), 'keep me');
  });
  it('does not launch or modify user files after a failed update', () => {
    // An unreadable origin stops before fetching; a refused fast-forward stops after it.
    for (const [code, environment, message] of [[1, {}, /Could not inspect origin/], [0, { TEST_MERGE_FAIL: '1' }, /could not fast-forward this checkout/]]) {
      const f = fixture(); const result = f.run(code, environment); assert.notEqual(result.status, 0); assert.doesNotMatch(f.log(), /launched/);
      assert.match(result.stderr + result.stdout, message);
      assert.equal(readFileSync(join(f.install, 'user-note.md'), 'utf8'), 'keep me');
    }
  });
  it('never launches an unverified tag or a checkout ahead of that tag', () => {
    for (const environment of [{ TEST_SIGNATURE_FAIL: '1' }, { TEST_AHEAD: '1' }]) {
      const f = fixture(); assert.notEqual(f.run(0, environment).status, 0);
      assert.doesNotMatch(f.log(), /launched/);
      assert.equal(readFileSync(join(f.install, 'user-note.md'), 'utf8'), 'keep me');
    }
  });
  it('verifies the tag only against the pinned release identity', () => {
    const clone = fixture('clone'); assert.equal(clone.run().status, 0); assert.match(clone.log(), /launched/);
    const f = fixture(); assert.equal(f.run().status, 0);
    assert.match(f.log(), /^xobash@users\.noreply\.github\.com namespaces="git" ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIFD4Ut8iLVnnB4ps75Fmr5gwgnHfmf\+Jm\+ZKZtVTr8Di$/m);
    assert.match(f.log(), /verify-tag --raw v0\.1\.0/);
  });
  it('never launches a tag signed by another key that Git accepts', () => {
    const foreign = [
      sshGood('xobash@users.noreply.github.com', foreignFingerprint),
      sshGood('someone@example.com', pinnedFingerprint),
      '[GNUPG:] GOODSIG 0123456789ABCDEF Someone <someone@example.com>\n[GNUPG:] VALIDSIG 0123456789ABCDEF0123456789ABCDEF01234567 2026-10-20 1792540800 0 4 0 22 10 00 0123456789ABCDEF0123456789ABCDEF01234567\n[GNUPG:] TRUST_ULTIMATE 0 pgp',
      '',
    ];
    for (const output of foreign) {
      for (const existing of [true, 'clone']) {
        const f = fixture(existing); const result = f.run(0, { TEST_SIGNATURE_OUTPUT: output });
        assert.notEqual(result.status, 0); assert.doesNotMatch(f.log(), /launched/);
        assert.match(result.stderr, /not signed by the Mesa release identity/);
      }
    }
  });
  it('refuses an occupied non-checkout folder', () => {
    const f = fixture(false); assert.notEqual(f.run().status, 0); assert.equal(f.log(), '');
    assert.equal(readFileSync(join(f.install, 'user-note.md'), 'utf8'), 'keep me');
  });
});


describe('verified prerequisite download', { skip: process.platform === 'win32' }, () => {
  it('publishes only matching bytes and preserves an existing destination on mismatch', () => {
    const root = mkdtempSync(join(tmpdir(), 'mesa-bootstrap-hash-')); folders.push(root);
    const bin = join(root, 'bin'); mkdirSync(bin);
    writeFileSync(join(bin, 'curl'), '#!/bin/bash\nwhile [[ "$1" != "-o" ]]; do shift; done\nprintf "reviewed bootstrap" > "$2"\n', { mode: 0o755 });
    const destination = join(root, 'download'); writeFileSync(destination, 'existing');
    const run = hash => spawnSync('/bin/bash', [resolve('scripts/bootstrap-download.sh'), 'https://example.com/bootstrap', hash, destination], { env: { ...process.env, PATH: `${bin}:${process.env.PATH}` }, encoding: 'utf8' });
    assert.notEqual(run('0'.repeat(64)).status, 0);
    assert.equal(readFileSync(destination, 'utf8'), 'existing');
    assert.equal(run(createHash('sha256').update('reviewed bootstrap').digest('hex')).status, 0);
    assert.equal(readFileSync(destination, 'utf8'), 'reviewed bootstrap');
  });
});

describe('pinned POSIX Node bootstrap', { skip: process.platform === 'win32' }, () => {
  // Fake curl/uname and a synthetic Node archive; only system tools stay on PATH.
  function nodeFixture() {
    const root = mkdtempSync(join(tmpdir(), 'mesa-node-bootstrap-')); folders.push(root);
    const bin = join(root, 'bin'), home = join(root, 'home'), source = join(root, 'archive'), log = join(root, 'calls');
    const top = join(source, 'node-v22.22.3-linux-x64', 'bin'); mkdirSync(bin); mkdirSync(home); mkdirSync(top, { recursive: true });
    writeFileSync(join(top, 'node'), '#!/bin/bash\nprintf "executed\\n" >> "$TEST_LOG"\nprintf "v22.22.3\\n"\n', { mode: 0o755 });
    writeFileSync(join(top, 'npm'), '#!/bin/bash\nprintf "10.0.0\\n"\n', { mode: 0o755 });
    const archive = join(root, 'node.tar.gz');
    assert.equal(spawnSync('tar', ['-czf', archive, '-C', source, 'node-v22.22.3-linux-x64']).status, 0);
    writeFileSync(join(bin, 'uname'), '#!/bin/bash\nif [[ "$1" == "-m" ]]; then printf "x86_64\\n"; else printf "Linux\\n"; fi\n', { mode: 0o755 });
    writeFileSync(join(bin, 'curl'), '#!/bin/bash\nprintf "curl %s\\n" "${@: -3:1}" >> "$TEST_LOG"\nif [[ "$TEST_CURL_FAIL" == "1" ]]; then exit 6; fi\nwhile [[ "$1" != "-o" ]]; do shift; done\ncp "$TEST_ARCHIVE" "$2"\n', { mode: 0o755 });
    // The reviewed script runs as-is; `reviewed` substitutes only the archive digest.
    const script = readFileSync(resolve('scripts/posix-node.sh'), 'utf8');
    const reviewedDigest = /linux-x64\) printf '([0-9a-f]{64})'/.exec(script)[1];
    const fakeDigest = createHash('sha256').update(readFileSync(archive)).digest('hex');
    writeFileSync(join(root, 'reviewed.sh'), script.replace(reviewedDigest, fakeDigest));
    writeFileSync(join(root, 'mismatch.sh'), script);
    const run = (variant, overrides = {}) => spawnSync('/bin/bash', ['-c', 'set -euo pipefail; source "$1"; source "$2"; mesa_ensure_node 22.22.3; node -v', 'node-bootstrap', resolve('scripts/bootstrap-download.sh'), join(root, `${variant}.sh`)], { env: { HOME: home, PATH: `${bin}:/usr/bin:/bin`, TEST_LOG: log, TEST_ARCHIVE: archive, ...overrides }, encoding: 'utf8' });
    const calls = () => { try { return readFileSync(log, 'utf8'); } catch { return ''; } };
    return { root, bin, home, run, calls, destination: join(home, '.local/share/mesa/toolchains/node-v22.22.3-linux-x64') };
  }
  it('rejects archive bytes that do not match the reviewed digest and executes nothing', () => {
    const f = nodeFixture(); const result = f.run('mismatch');
    assert.notEqual(result.status, 0); assert.match(result.stderr, /checksum mismatch/);
    assert.doesNotMatch(f.calls(), /executed/); assert.equal(existsSync(f.destination), false);
  });
  it('installs the verified archive user-locally and reuses it offline on relaunch', () => {
    const f = nodeFixture(); const first = f.run('reviewed');
    assert.equal(first.status, 0, first.stderr); assert.match(first.stdout, /v22\.22\.3\n$/);
    assert.match(f.calls(), /curl https:\/\/nodejs\.org\/dist\/v22\.22\.3\/node-v22\.22\.3-linux-x64\.tar\.gz/);
    assert.ok(existsSync(join(f.destination, 'bin/node')));
    const second = f.run('reviewed', { TEST_CURL_FAIL: '1' });
    assert.equal(second.status, 0, second.stderr); assert.equal(f.calls().match(/curl /g).length, 1);
  });
  it('never sources or modifies an existing nvm, and replaces a different PATH Node', () => {
    const f = nodeFixture(); const nvm = join(f.root, 'nvm'); mkdirSync(nvm);
    const sentinel = 'printf "nvm sourced\\n" >> "$TEST_LOG"\n'; writeFileSync(join(nvm, 'nvm.sh'), sentinel); writeFileSync(join(nvm, 'nvm-exec'), sentinel);
    writeFileSync(join(f.bin, 'node'), '#!/bin/bash\nprintf "v20.0.0\\n"\n', { mode: 0o755 });
    const result = f.run('reviewed', { NVM_DIR: nvm });
    assert.equal(result.status, 0, result.stderr); assert.match(result.stdout, /v22\.22\.3\n$/);
    assert.equal(readFileSync(join(nvm, 'nvm.sh'), 'utf8'), sentinel); assert.equal(readFileSync(join(nvm, 'nvm-exec'), 'utf8'), sentinel);
    assert.doesNotMatch(f.calls(), /nvm sourced/);
  });
  it('keeps an existing Node only when it is exactly the pin', () => {
    const f = nodeFixture();
    writeFileSync(join(f.bin, 'node'), '#!/bin/bash\nprintf "v22.22.3\\n"\n', { mode: 0o755 });
    writeFileSync(join(f.bin, 'npm'), '#!/bin/bash\nprintf "10.0.0\\n"\n', { mode: 0o755 });
    const result = f.run('mismatch', { TEST_CURL_FAIL: '1' });
    assert.equal(result.status, 0, result.stderr); assert.equal(f.calls(), '');
  });
});

describe('pinned POSIX Rust bootstrap', { skip: process.platform === 'win32' }, () => {
  // Fake cargo/rustc/curl/uname and a fake rustup-init; only system tools stay on PATH.
  function rustFixture() {
    const root = mkdtempSync(join(tmpdir(), 'mesa-rust-bootstrap-')); folders.push(root);
    const bin = join(root, 'bin'), home = join(root, 'home'), log = join(root, 'calls'), installer = join(root, 'rustup-init');
    mkdirSync(bin); mkdirSync(home);
    writeFileSync(join(bin, 'uname'), '#!/bin/bash\nif [[ "$1" == "-m" ]]; then printf "x86_64\\n"; else printf "Linux\\n"; fi\n', { mode: 0o755 });
    writeFileSync(join(bin, 'curl'), '#!/bin/bash\nprintf "curl %s\\n" "${@: -3:1}" >> "$TEST_LOG"\nwhile [[ "$1" != "-o" ]]; do shift; done\ncp "$TEST_INSTALLER" "$2"\n', { mode: 0o755 });
    // The fake installer writes a rustup-managed ~/.cargo with the requested toolchain.
    writeFileSync(installer, '#!/bin/bash\nprintf "rustup-init %s\\n" "$*" >> "$TEST_LOG"\nmkdir -p "$HOME/.cargo/bin"\nfor tool in cargo rustc rustup; do printf "#!/bin/bash\\nprintf \\"%s 1.96.0 (pinned)\\\\n\\"\\n" "$tool" > "$HOME/.cargo/bin/$tool"; chmod 755 "$HOME/.cargo/bin/$tool"; done\nprintf "export PATH=\\"\\$HOME/.cargo/bin:\\$PATH\\"\\n" > "$HOME/.cargo/env"\n', { mode: 0o755 });
    const script = readFileSync(resolve('scripts/posix-rust.sh'), 'utf8');
    const reviewedDigest = /x86_64-unknown-linux-gnu ([0-9a-f]{64})/.exec(script)[1];
    writeFileSync(join(root, 'reviewed.sh'), script.replace(reviewedDigest, createHash('sha256').update(readFileSync(installer)).digest('hex')));
    const system = (version) => {
      writeFileSync(join(bin, 'cargo'), `#!/bin/bash\nprintf "cargo ${version}\\n"\n`, { mode: 0o755 });
      writeFileSync(join(bin, 'rustc'), `#!/bin/bash\nprintf "rustc ${version} (system)\\n"\n`, { mode: 0o755 });
    };
    const run = () => spawnSync('/bin/bash', ['-c', 'set -euo pipefail; source "$1"; source "$2"; mesa_ensure_rust 1.96.0; rustc --version', 'rust-bootstrap', resolve('scripts/bootstrap-download.sh'), join(root, 'reviewed.sh')], { env: { HOME: home, PATH: `${bin}:/usr/bin:/bin`, TEST_LOG: log, TEST_INSTALLER: installer }, encoding: 'utf8' });
    const calls = () => { try { return readFileSync(log, 'utf8'); } catch { return ''; } };
    return { bin, system, run, calls };
  }
  it('installs pinned rustup beside a different system Rust without removing it', () => {
    const f = rustFixture(); f.system('1.80.0');
    const result = f.run();
    assert.equal(result.status, 0, result.stderr); assert.match(result.stdout, /^rustc 1\.96\.0 \(pinned\)\n$/);
    assert.match(f.calls(), /curl https:\/\/static\.rust-lang\.org\/rustup\/archive\/1\.28\.2\/x86_64-unknown-linux-gnu\/rustup-init/);
    assert.match(f.calls(), /rustup-init -y --no-modify-path --default-toolchain 1\.96\.0/);
    assert.ok(existsSync(join(f.bin, 'rustc'))); assert.match(result.stderr, /Rust 1\.80\.0 without rustup/);
  });
  it('keeps a system Rust that is exactly the pin, and any rustup install', () => {
    const exact = rustFixture(); exact.system('1.96.0');
    const kept = exact.run();
    assert.equal(kept.status, 0, kept.stderr); assert.match(kept.stdout, /\(system\)/); assert.equal(exact.calls(), '');
    const managed = rustFixture(); managed.system('1.80.0');
    writeFileSync(join(managed.bin, 'rustup'), '#!/bin/bash\nexit 0\n', { mode: 0o755 });
    const proxied = managed.run();
    assert.equal(proxied.status, 0, proxied.stderr); assert.equal(managed.calls(), '');
  });
  it('installs pinned rustup when no Rust is present', () => {
    const f = rustFixture(); const result = f.run();
    assert.equal(result.status, 0, result.stderr); assert.match(result.stdout, /\(pinned\)/);
    assert.match(f.calls(), /rustup-init -y --no-modify-path --default-toolchain 1\.96\.0/);
  });
});

// Windows setup scripts run only on Windows CI (windows-installer-behavior.check.ps1
// executes them); these text checks keep each fix visible on every OS.
describe('Windows setup script contracts', () => {
  const text = file => readFileSync(resolve(file), 'utf8').replace(/\r\n/g, '\n');
  const label = (script, name) => { const at = script.indexOf(`\n:${name}\n`); assert.ok(at >= 0, `:${name} is missing`); const end = script.indexOf('\n:', at + 2); return script.slice(at, end < 0 ? undefined : end); };
  it('keeps "!" in paths: delayed expansion is off except for the stamp write', () => {
    const run = text('run.cmd');
    assert.match(run, /^@echo off\n(?:REM [^\n]*\n)*setlocal disabledelayedexpansion\n/);
    const bangs = run.split('\n').filter(line => /![A-Za-z_]+!/.test(line) && !/^REM /.test(line));
    assert.deepEqual(bangs, ['>"%STAMP%" echo !CD!']);
    assert.match(label(run, 'write_build_stamp'), /setlocal enabledelayedexpansion\n>"%STAMP%" echo !CD!\nendlocal/);
    assert.match(label(run, 'check_long_paths'), /echo {7}"%CD%"\n/);
  });
  it('compares the stamped build path without case', () => {
    assert.match(label(text('run.cmd'), 'checkmoved'), /if \/i not "%LASTPATH%"=="%CD%" \(/);
  });
  it('never restarts Windows while installing the C++ Build Tools', () => {
    const run = text('run.cmd');
    const install = label(run, 'install_build_tools');
    assert.match(install, /--override "--quiet --wait --norestart /);
    assert.match(install, /for %%S in \(3010 1641 -1978334967\) do if "%MESA_INSTALL_STATUS%"=="%%S" goto build_tools_restart\n/);
    // 0x8A15010A: nothing was installed, so it must not say "were installed".
    assert.match(install, /if "%MESA_INSTALL_STATUS%"=="-1978334966" goto build_tools_restart_first\n/);
    assert.match(label(run, 'build_tools_restart_first'), /Nothing was installed\./);
    assert.doesNotMatch(label(run, 'build_tools_restart_first'), /were installed/);
    assert.match(run, /call :install_build_tools\n {4}if errorlevel 1 exit \/b 1/);
    assert.equal(run.match(/Microsoft\.VisualStudio\.2022\.BuildTools/g).length, 1);
  });
  it('gives advice that is right for a missing and an old WebView2', () => {
    const probe = label(text('run.cmd'), 'has_webview2');
    assert.match(probe, /echo {3}! Microsoft Edge WebView2 Runtime %MESA_WEBVIEW2_MIN_MAJOR% or newer was not found\./);
    assert.doesNotMatch(probe, /installed but older/);
  });
  it('accepts only a cl.exe that builds for x64', () => {
    const run = text('run.cmd');
    assert.match(label(run, 'has_msvc_tools'), /where cl >nul 2>nul\nif errorlevel 1 goto find_msvc_tools\ncall :cl_targets_x64\nif not errorlevel 1 exit \/b 0\n/);
    assert.match(label(run, 'cl_targets_x64'), /if \/i not "%VSCMD_ARG_TGT_ARCH%"=="x64" exit \/b 1\ncl 2>&1 \| findstr \/i \/c:" x64" >nul/);
  });
  it('never lets winget replace an installed machine-wide Node.js', () => {
    const ensure = label(text('run.cmd'), 'ensure_node');
    const guard = ensure.indexOf('if exist "%ProgramFiles%\\nodejs\\node.exe" (');
    assert.ok(guard > 0 && guard < ensure.indexOf('call :install_winget OpenJS.NodeJS.22'));
    assert.ok(ensure.indexOf('call :install_pinned_node') < guard, 'the pinned download stays first');
  });
  it('downloads the pinned Node.js with TLS 1.2 and no progress bar', () => {
    const node = text('scripts/windows-node.ps1');
    for (const setting of ["$ProgressPreference = 'SilentlyContinue'", '[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12']) {
      assert.ok(node.indexOf(setting) > 0 && node.indexOf(setting) < node.indexOf('Invoke-WebRequest'), setting);
      const guide = text('docs/release.md'); const oneLiner = guide.slice(guide.indexOf("& { $ErrorActionPreference = 'Stop';"));
      assert.ok(oneLiner.indexOf(setting) > 0 && oneLiner.indexOf(setting) < oneLiner.indexOf('Invoke-WebRequest'), `release guide: ${setting}`);
    }
  });
  it('installs outside Windows folders, warns about OneDrive and needs Git 2.34', () => {
    const install = text('install.ps1');
    assert.match(install, /\(Test-PathUnder \(\[string\]\$currentDir\) \$env:SystemRoot\)[^\n]*\n(?:\s*#[^\n]*\n)*\s*Join-Path \$env:USERPROFILE "xo-mesa"/);
    assert.match(install, /foreach \(\$oneDrive in @\(\$env:OneDrive, \$env:OneDriveConsumer, \$env:OneDriveCommercial\)\)/);
    const version = install.indexOf('[version]"2.34"');
    assert.ok(version > install.indexOf('  Ensure-Git\n') && version < install.indexOf('  if (Test-Path (Join-Path $installDir ".git")) {'), 'Git version is checked before any clone or update');
  });
  it('keeps the installer check runnable under Windows PowerShell 5.1', () => {
    const check = text('scripts/windows-installer-behavior.check.ps1');
    const code = check.slice(0, check.indexOf("$nodeProbe = @'")) + check.slice(check.indexOf("'@", check.indexOf("$nodeProbe = @'")));
    const harness = code.split('\n').filter(line => !/^\s*#/.test(line)).join('\n');
    // 5.1 throws NativeCommandError on redirected native stderr; module cmdlets can be hidden by an inherited PSModulePath.
    assert.doesNotMatch(harness, /\*> \$null|\(Get-FileHash \$|^\s*Compress-Archive /m);
    assert.doesNotMatch(harness, /^\s*& cmd\.exe/m, 'run cmd.exe probes through Invoke-Cmd');
  });
});

it('release guide bootstrap checksums match the complete installer bytes', () => {
  const guide = readFileSync(resolve('docs/release.md'), 'utf8');
  for (const file of ['install.sh', 'install.ps1']) {
    const hash = createHash('sha256').update(readFileSync(resolve(file))).digest('hex');
    assert.ok(guide.includes(hash), `Release guide checksum for ${file} is stale`);
  }
});
