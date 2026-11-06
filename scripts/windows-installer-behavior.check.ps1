$ErrorActionPreference = 'Stop'
$project = Split-Path $PSScriptRoot -Parent
$temporary = Join-Path ([System.IO.Path]::GetTempPath()) ("mesa-installer-check-" + [guid]::NewGuid().ToString('N'))
$checkout = Join-Path $temporary 'xo-mesa'
$launchLog = Join-Path $temporary 'launch.log'
$runner = Join-Path $temporary 'run.cmd'
$priorDirectory = Get-Location
$priorMesaDir = $env:MESA_DIR
$priorLaunchLog = $env:MESA_TEST_LAUNCH
$priorPath = $env:Path
$priorProgramFiles = $env:ProgramFiles
$priorProgramFilesX86 = ${env:ProgramFiles(x86)}
$priorLocalAppData = $env:LOCALAPPDATA
$priorModulePath = $env:PSModulePath
# Synthetic `git verify-tag --raw` lines; fingerprints are joined from fragments.
$pinnedFingerprint = @('SHA256', 'JTK3hA6m0Hr2/77nrt0wTl0n38Lrl8HuraqKbvZd3so') -join ':'
$foreignFingerprint = @('SHA256', 'heOwUFRozvdEk4SCyDUZHIS3van9fJdZ+aTvrWbROUk') -join ':'
function Get-SshGoodLine([string]$principal, [string]$fingerprint) { @('Good "git" signature for', $principal, 'with ED25519', 'key', $fingerprint) -join ' ' }
$global:mesaPinnedSignature = Get-SshGoodLine 'xobash@users.noreply.github.com' $pinnedFingerprint

function Assert-True([bool]$condition, [string]$message) {
  if (-not $condition) { throw $message }
}

# Windows PowerShell 5.1 turns redirected native stderr into a terminating
# NativeCommandError under ErrorActionPreference Stop, so cmd.exe probes run
# with Continue. Returns the exit status; the output is in $global:mesaCmdOutput.
function Invoke-Cmd([string]$commandLine) {
  $prior = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try { $output = @(& cmd.exe /d /c $commandLine 2>&1 | ForEach-Object { "$_" }) } finally { $ErrorActionPreference = $prior }
  $global:mesaCmdOutput = $output -join "`n"
  return $LASTEXITCODE
}

# Hashing and zipping use .NET, not module cmdlets: an inherited PSModulePath
# from the other PowerShell edition can hide Get-FileHash and Compress-Archive.
function Get-Sha256Hex([string]$path) {
  $sha = [System.Security.Cryptography.SHA256]::Create()
  try { return (($sha.ComputeHash([System.IO.File]::ReadAllBytes($path)) | ForEach-Object { $_.ToString('X2') }) -join '') } finally { $sha.Dispose() }
}

function global:git {
  $call = @($args) -join ' '
  $global:mesaGitCalls += $call
  $global:LASTEXITCODE = 0
  if ($call -eq '--version') { Write-Output $global:mesaGitVersion
  } elseif ($call -match 'remote get-url origin') { Write-Output 'https://github.com/xobash/xo-mesa.git'
  } elseif ($call -match '\bstatus\b') {
    if ($global:mesaHasChanges) { Write-Output ' M note.md' }
  } elseif ($call -match 'verify-tag') {
    foreach ($argument in $args) {
      if ([string]$argument -like 'gpg.ssh.allowedSignersFile=*') { $global:mesaSigners = Get-Content -Raw ([string]$argument).Substring(27) }
    }
    if ($null -ne $global:mesaSignatureOutput) { Write-Output $global:mesaSignatureOutput } else { Write-Output $global:mesaPinnedSignature }
    if ($global:mesaSignatureFails) { $global:LASTEXITCODE = 1 }
  } elseif ($call -match 'rev-parse HEAD' -and $global:mesaAhead) {
    Write-Output 'ahead'
  } elseif ($call -match '\brev-parse\b') {
    Write-Output 'abc123'
  } elseif ($call -match 'stash apply' -and $global:mesaApplyFails) {
    $global:LASTEXITCODE = 1
  } elseif ($call -match '\bmerge\b' -and $global:mesaMergeFails) {
    $global:LASTEXITCODE = 1
  } elseif ($call -match '\bclone\b') {
    $target = [string]$args[-1]
    New-Item -ItemType Directory -Force (Join-Path $target '.git') | Out-Null
    Copy-Item $runner (Join-Path $target 'run.cmd')
  }
}

try {
  New-Item -ItemType Directory -Force $temporary | Out-Null
  Set-Content -Path $runner -Value "@echo off`r`n>>`"%MESA_TEST_LAUNCH%`" echo launched" -NoNewline
  $env:MESA_DIR = $checkout
  $env:MESA_TEST_LAUNCH = $launchLog

  $global:mesaGitVersion = 'git version 2.47.1.windows.1'
  $global:mesaGitCalls = @()
  $global:mesaHasChanges = $false
  $global:mesaMergeFails = $false
  $global:mesaSignatureFails = $false
  $global:mesaAhead = $false
  $global:mesaApplyFails = $false
  Invoke-Expression (Get-Content -Raw (Join-Path $project 'install.ps1'))
  Assert-True (Test-Path $launchLog) 'fresh clone did not launch Mesa'
  Assert-True (($global:mesaGitCalls -join "`n") -match '\bclone\b') 'fresh checkout was not cloned'
  Assert-True (($global:mesaGitCalls -join "`n") -match 'verify-tag --raw v0\.1\.0') 'release tag was not verified with raw output'
  Assert-True ($global:mesaSigners -ceq "xobash@users.noreply.github.com namespaces=`"git`" ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIFD4Ut8iLVnnB4ps75Fmr5gwgnHfmf+Jm+ZKZtVTr8Di`n") 'release tag was not verified against the pinned key only'

  Set-Location $temporary
  Remove-Item $launchLog
  $global:mesaGitCalls = @()
  $global:mesaHasChanges = $true
  Invoke-Expression (Get-Content -Raw (Join-Path $project 'install.ps1'))
  $calls = $global:mesaGitCalls -join "`n"
  Assert-True ($calls -match 'stash push --include-untracked') 'local changes were not preserved'
  Assert-True ($calls -match 'fetch --no-tags origin refs/tags/v0.1.0:refs/tags/v0.1.0') 'origin was not fetched'
  Assert-True ($calls -match 'merge --ff-only refs/tags/v0.1.0') 'update was not limited to fast-forward'
  # Real git rejects `stash pop <commit>`; the exact commit must be applied.
  Assert-True ($calls -notmatch 'stash pop') 'stash pop cannot take the preserved commit id'
  Assert-True ($calls -match 'stash apply abc123') 'local changes were not restored'
  Assert-True ($calls -match 'stash drop') 'restored stash entry was not dropped'
  Assert-True (Test-Path $launchLog) 'successful update did not launch Mesa'

  Set-Location $temporary
  Remove-Item $launchLog
  $global:mesaGitCalls = @()
  $global:mesaApplyFails = $true
  $failed = $false
  try { Invoke-Expression (Get-Content -Raw (Join-Path $project 'install.ps1')) } catch { $failed = $true }
  Assert-True $failed 'conflicting restore was accepted'
  Assert-True (($global:mesaGitCalls -join "`n") -notmatch 'stash drop') 'conflicting restore dropped the preserved stash'
  Assert-True (-not (Test-Path $launchLog)) 'conflicting restore launched Mesa'
  $global:mesaApplyFails = $false

  Set-Location $temporary
  $global:mesaGitCalls = @()
  $global:mesaMergeFails = $true
  $failed = $false
  try { Invoke-Expression (Get-Content -Raw (Join-Path $project 'install.ps1')) } catch { $failed = $true }
  Assert-True $failed 'failed fast-forward was accepted'
  Assert-True (($global:mesaGitCalls -join "`n") -match 'stash apply abc123') 'failed update did not restore local changes'
  Assert-True (-not (Test-Path $launchLog)) 'failed update launched Mesa'

  $global:mesaMergeFails = $false
  foreach ($failure in @('signature', 'ahead')) {
    $global:mesaSignatureFails = $failure -eq 'signature'
    $global:mesaAhead = $failure -eq 'ahead'
    $failed = $false
    try { Invoke-Expression (Get-Content -Raw (Join-Path $project 'install.ps1')) } catch { $failed = $true }
    Assert-True $failed "untrusted $failure checkout was accepted"
    Assert-True (-not (Test-Path $launchLog)) "untrusted $failure checkout launched Mesa"
  }

  # Git accepts any key in the caller's keyring; only the pinned identity may launch.
  $global:mesaAhead = $false
  $global:mesaSignatureFails = $false
  foreach ($foreign in @(
    (Get-SshGoodLine 'xobash@users.noreply.github.com' $foreignFingerprint),
    (Get-SshGoodLine 'someone@example.com' $pinnedFingerprint),
    "[GNUPG:] GOODSIG 0123456789ABCDEF Someone <someone@example.com>`n[GNUPG:] VALIDSIG 0123456789ABCDEF0123456789ABCDEF01234567 2026-10-20 1792540800 0 4 0 22 10 00 0123456789ABCDEF0123456789ABCDEF01234567",
    '')) {
    $global:mesaSignatureOutput = $foreign
    foreach ($fresh in @($false, $true)) {
      if ($fresh) { Remove-Item -Recurse -Force $checkout -ErrorAction SilentlyContinue }
      if (Test-Path $launchLog) { Remove-Item $launchLog }
      Set-Location $temporary
      $failed = $false
      try { Invoke-Expression (Get-Content -Raw (Join-Path $project 'install.ps1')) } catch { $failed = $true; Assert-True ("$_" -match 'not signed by the Mesa release identity') "foreign signature failed for another reason: $_" }
      Assert-True $failed "foreign signature was accepted: $foreign"
      Assert-True (-not (Test-Path $launchLog)) "foreign signature launched Mesa: $foreign"
    }
  }
  $global:mesaSignatureOutput = $null

  # Under iex a relative MESA_DIR follows the PowerShell location, which can
  # differ from the process working directory.
  $priorProcessDirectory = [Environment]::CurrentDirectory
  try {
    Set-Location $temporary
    [Environment]::CurrentDirectory = $env:SystemRoot
    $env:MESA_DIR = 'relative checkout'
    if (Test-Path $launchLog) { Remove-Item $launchLog }
    $global:mesaGitCalls = @()
    Invoke-Expression (Get-Content -Raw (Join-Path $project 'install.ps1'))
    Assert-True (Test-Path (Join-Path $temporary 'relative checkout\.git')) 'relative MESA_DIR did not resolve against the PowerShell location'
    Assert-True (Test-Path $launchLog) 'relative MESA_DIR checkout did not launch Mesa'
  } finally {
    [Environment]::CurrentDirectory = $priorProcessDirectory
    $env:MESA_DIR = $checkout
  }

  # Git older than 2.34 cannot verify SSH-signed tags; stop before cloning.
  $priorProfile = $env:USERPROFILE
  try {
    foreach ($old in @('git version 2.33.1.windows.1', 'unexpected')) {
      $global:mesaGitVersion = $old
      $global:mesaGitCalls = @()
      $failed = $false
      try { Invoke-Expression (Get-Content -Raw (Join-Path $project 'install.ps1')) } catch { $failed = $true; Assert-True ("$_" -match 'Git 2\.34 or newer') "old Git failed for another reason: $_" }
      Assert-True $failed "Git '$old' was accepted"
      Assert-True (($global:mesaGitCalls -join "`n") -notmatch '\bclone\b|\bfetch\b') "Git '$old' reached clone or fetch"
    }
    $global:mesaGitVersion = 'git version 2.34.0'

    # Without MESA_DIR, an elevated shell's System32 location never receives
    # the checkout; it goes to the user profile instead.
    $env:MESA_DIR = $null
    $env:USERPROFILE = Join-Path $temporary 'profile'
    New-Item -ItemType Directory -Force $env:USERPROFILE | Out-Null
    Set-Location (Join-Path $env:SystemRoot 'System32')
    if (Test-Path $launchLog) { Remove-Item $launchLog }
    Invoke-Expression (Get-Content -Raw (Join-Path $project 'install.ps1'))
    Assert-True (Test-Path (Join-Path $env:USERPROFILE 'xo-mesa\.git')) 'a System32 location did not install into the user profile'
    Assert-True (-not (Test-Path (Join-Path $env:SystemRoot 'System32\xo-mesa'))) 'the checkout was created inside System32'

    # A OneDrive folder is allowed, with a warning about locked build files.
    $priorOneDrive = $env:OneDrive
    try {
      $env:OneDrive = $temporary
      $env:MESA_DIR = Join-Path $temporary 'onedrive checkout'
      Set-Location $temporary
      $warnings = @(Invoke-Expression (Get-Content -Raw (Join-Path $project 'install.ps1')) 3>&1 | Where-Object { $_ -is [System.Management.Automation.WarningRecord] })
      Assert-True (($warnings | ForEach-Object { $_.Message }) -match 'OneDrive') 'a OneDrive install folder was not warned about'
      $env:OneDrive = Join-Path $temporary 'elsewhere'
      $warnings = @(Invoke-Expression (Get-Content -Raw (Join-Path $project 'install.ps1')) 3>&1 | Where-Object { $_ -is [System.Management.Automation.WarningRecord] })
      Assert-True ($warnings.Count -eq 0) 'a folder outside OneDrive was warned about'
    } finally { $env:OneDrive = $priorOneDrive }
  } finally {
    $env:USERPROFILE = $priorProfile
    $env:MESA_DIR = $checkout
    $global:mesaGitVersion = 'git version 2.47.1.windows.1'
    Set-Location $temporary
  }

  $runScript = Get-Content -Raw (Join-Path $project 'run.cmd')
  # Exercise the actual launch subroutine with a module path that excludes
  # Windows PowerShell's built-ins, as an intermediate cmd process can inherit.
  $nodeAt = $runScript.IndexOf("`n:install_pinned_node")
  $nodeEnd = $runScript.IndexOf("`n:ensure_scoop", $nodeAt + 1)
  Assert-True ($nodeAt -ge 0 -and $nodeEnd -gt $nodeAt) 'pinned Node launch subroutine is missing'
  Assert-True ($runScript -match 'call :install_pinned_node') 'pinned Node launch bypasses module isolation'
  $nodeFixture = Join-Path $temporary 'node probe'
  New-Item -ItemType Directory -Force (Join-Path $nodeFixture 'scripts') | Out-Null
  $payload = Join-Path $nodeFixture 'payload.txt'
  Set-Content $payload 'archive payload'
  $expectedHash = Get-Sha256Hex $payload
  Add-Type -AssemblyName System.IO.Compression, System.IO.Compression.FileSystem
  $zip = [System.IO.Compression.ZipFile]::Open((Join-Path $nodeFixture 'payload.zip'), 'Create')
  try { [void][System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile($zip, $payload, 'payload.txt') } finally { $zip.Dispose() }
  $nodeProbe = @'
$ErrorActionPreference = 'Stop'
if ($env:MESA_TEST_NODE_FAIL -eq '1') { exit 23 }
Import-Module Microsoft.PowerShell.Utility -Force
if ((Get-FileHash 'payload.txt' -Algorithm SHA256).Hash -ne $env:MESA_TEST_NODE_HASH) { throw 'Hash mismatch' }
Expand-Archive 'payload.zip' -DestinationPath 'expanded' -Force
if ((Get-Content 'expanded/payload.txt' -Raw).Trim() -ne 'archive payload') { throw 'Extraction failed' }
'@
  Set-Content (Join-Path $nodeFixture 'scripts/windows-node.ps1') $nodeProbe
  $nodeRunner = Join-Path $nodeFixture 'probe.cmd'
  $nodeBody = "@echo off`r`nset `"PSModulePath=%MESA_TEST_MODULE_PATH%`"`r`ncall :install_pinned_node`r`nset `"MESA_TEST_NODE_STATUS=%errorlevel%`"`r`nif not `"%PSModulePath%`"==`"%MESA_TEST_MODULE_PATH%`" exit /b 99`r`nexit /b %MESA_TEST_NODE_STATUS%`r`n" + $runScript.Substring($nodeAt + 1, $nodeEnd - $nodeAt - 1)
  Set-Content $nodeRunner $nodeBody
  $moduleFolder = Join-Path $temporary 'incompatible modules'
  $utility = Join-Path $moduleFolder 'Microsoft.PowerShell.Utility'
  New-Item -ItemType Directory $utility | Out-Null
  Set-Content (Join-Path $utility 'Microsoft.PowerShell.Utility.psd1') "@{RootModule='Microsoft.PowerShell.Utility.psm1';ModuleVersion='99.0.0';GUID='4416d4f0-cc57-4c56-9314-69d20465b81e';FunctionsToExport=@('Get-FileHash')}"
  Set-Content (Join-Path $utility 'Microsoft.PowerShell.Utility.psm1') "throw 'This fixture represents a module incompatible with Windows PowerShell.'"
  $env:PSModulePath = $moduleFolder
  $env:MESA_TEST_MODULE_PATH = $moduleFolder
  $env:MESA_TEST_NODE_HASH = $expectedHash
  Set-Location $nodeFixture
  $status = Invoke-Cmd 'set "PSModulePath=%MESA_TEST_MODULE_PATH%"&& powershell -NoProfile -ExecutionPolicy Bypass -File scripts\windows-node.ps1'
  Assert-True ($status -ne 0) 'broken inherited module path did not reproduce the failure'
  $status = Invoke-Cmd "`"$nodeRunner`""
  Assert-True ($status -eq 0) "isolated launch could not hash/extract or changed the caller module path: $global:mesaCmdOutput"
  $env:MESA_TEST_NODE_FAIL = '1'
  $status = Invoke-Cmd "`"$nodeRunner`""
  Assert-True ($status -eq 23) 'isolated launch lost the prerequisite failure status'
  $env:PSModulePath = $priorModulePath
  Set-Location $temporary
  $probeAt = $runScript.IndexOf("`n:has_webview2")
  Assert-True ($probeAt -ge 0) 'WebView2 probe is missing'
  $probe = Join-Path $temporary 'webview-probe.cmd'
  $probeBody = "@echo off`r`nset `"MESA_WEBVIEW2_MIN_MAJOR=111`"`r`ncall :has_webview2`r`nexit /b %errorlevel%`r`n" + $runScript.Substring($probeAt + 1)
  Set-Content -Path $probe -Value $probeBody
  Set-Content -Path (Join-Path $temporary 'reg.cmd') -Value "@echo off`r`necho pv REG_SZ %MESA_TEST_WEBVIEW2_VERSION%"
  $env:Path = "$temporary;$priorPath"
  $env:ProgramFiles = $temporary
  ${env:ProgramFiles(x86)} = $temporary
  $env:LOCALAPPDATA = $temporary
  # A missing runtime and an old one need different advice, and the message
  # names the newest version found: registry 110 beats an older 105 folder
  # that the executable fallback probes last.
  $oldRuntime = Join-Path $temporary 'Microsoft\EdgeWebView\Application\105.0.0.0'
  New-Item -ItemType Directory -Force $oldRuntime | Out-Null
  Set-Content (Join-Path $oldRuntime 'msedgewebview2.exe') ''
  foreach ($case in @(@('110.0.0.0', 1, 'newest WebView2 found, 110.0.0.0, is older than'), @('111.0.0.0', 0, ''), @('120.0.0.0', 0, ''), @('0.0.0.0', 1, 'newest WebView2 found, 105.0.0.0, is older than'))) {
    $env:MESA_TEST_WEBVIEW2_VERSION = $case[0]
    $status = Invoke-Cmd "`"$probe`""
    Assert-True ($status -eq $case[1]) "WebView2 probe returned $status for $($case[0])"
    if ($case[2]) { Assert-True ($global:mesaCmdOutput.Contains($case[2])) "WebView2 probe for $($case[0]) said: $global:mesaCmdOutput" }
  }
  Remove-Item (Join-Path $temporary 'Microsoft') -Recurse -Force
  $env:MESA_TEST_WEBVIEW2_VERSION = '0.0.0.0'
  $status = Invoke-Cmd "`"$probe`""
  Assert-True ($status -eq 1 -and $global:mesaCmdOutput.Contains('WebView2 Runtime is not installed')) "missing WebView2 said: $global:mesaCmdOutput"
  # An empty PATH has no Node, npm, Scoop or winget. The pinned download must
  # run first; winget with the exact pinned version is only the fallback.
  $ensureAt = $runScript.IndexOf("`n:ensure_node")
  $ensureEnd = $runScript.IndexOf("`n:refresh_paths", $ensureAt + 1)
  Assert-True ($ensureAt -ge 0 -and $ensureEnd -gt $ensureAt) 'Node acquisition subroutine is missing'
  $nodeArch = if ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64') { 'arm64' } else { 'x64' }
  $env:MESA_TEST_PINNED_DIR = Join-Path $temporary "Mesa\toolchains\node-v22.22.3-win-$nodeArch"
  $env:MESA_TEST_NODE_LOG = Join-Path $temporary 'node-steps.log'
  $fakeSteps = @(
    ':install_pinned_node', '>>"%MESA_TEST_NODE_LOG%" echo pinned', 'if "%MESA_TEST_PINNED_FAIL%"=="1" exit /b 1',
    'mkdir "%MESA_TEST_PINNED_DIR%" 2>nul', '>"%MESA_TEST_PINNED_DIR%\node.cmd" echo @echo v%MESA_NODE_VERSION%', 'exit /b 0',
    ':install_winget', '>>"%MESA_TEST_NODE_LOG%" echo winget %~1 %~3', 'exit /b 1',
    ':refresh_paths', 'exit /b 0') -join "`r`n"
  $nodeSteps = Join-Path $temporary 'node-steps.cmd'
  $nodeStepsBody = "@echo off`r`nsetlocal disabledelayedexpansion`r`nset `"MESA_NODE_VERSION=22.22.3`"`r`ncall :ensure_node`r`nexit /b %errorlevel%`r`n" + ($runScript.Substring($ensureAt + 1, $ensureEnd - $ensureAt - 1) -replace "`r?`n", "`r`n") + "`r`n" + $fakeSteps + "`r`n"
  Set-Content -Path $nodeSteps -Value $nodeStepsBody
  $env:Path = Join-Path $env:SystemRoot 'System32'
  $env:LOCALAPPDATA = $temporary
  # Winget's machine-wide MSI never replaces a Node.js already in Program Files.
  $machineNode = Join-Path $env:ProgramFiles 'nodejs\node.exe'
  foreach ($case in @(@('0', 0, 'pinned', $false), @('1', 1, "pinned`r`nwinget OpenJS.NodeJS.22 22.22.3", $false), @('1', 1, 'pinned', $true))) {
    Remove-Item $env:MESA_TEST_NODE_LOG, $env:MESA_TEST_PINNED_DIR -Recurse -Force -ErrorAction SilentlyContinue
    Remove-Item (Split-Path $machineNode) -Recurse -Force -ErrorAction SilentlyContinue
    if ($case[3]) { New-Item -ItemType Directory -Force (Split-Path $machineNode) | Out-Null; Set-Content $machineNode '' }
    $env:MESA_TEST_PINNED_FAIL = $case[0]
    $status = Invoke-Cmd "`"$nodeSteps`""
    Assert-True ($status -eq $case[1]) "empty-PATH Node setup returned $status (pinned failure: $($case[0]))"
    $steps = (Get-Content -Raw $env:MESA_TEST_NODE_LOG).Trim()
    Assert-True ($steps -ceq $case[2]) "empty-PATH Node setup ran: $steps"
    if ($case[3]) { Assert-True ($global:mesaCmdOutput -match 'Winget would replace the Node\.js') "existing machine-wide Node was not explained: $global:mesaCmdOutput" }
  }
  Remove-Item (Split-Path $machineNode) -Recurse -Force -ErrorAction SilentlyContinue
  # A later PATH refresh adds %ProgramFiles%\nodejs. The activated pin must stay
  # first, and the pre-npm check must reject a system Node that wins instead.
  # :require_pinned_node calls :node_version, which precedes :use_pinned_node.
  $useAt = $runScript.IndexOf("`n:node_version")
  $useEnd = $runScript.IndexOf("`n:has_webview2", $useAt + 1)
  Assert-True ($useAt -ge 0 -and $useEnd -gt $useAt) 'pinned Node activation subroutines are missing'
  Assert-True ($runScript -match "call :require_pinned_node\r?\nif errorlevel 1 exit /b 1\r?\n\r?\ncall node scripts\\launch-cache\.mjs check-deps") 'npm runs without re-verifying the pinned Node'
  $systemNode = Join-Path $temporary 'nodejs'
  New-Item -ItemType Directory -Force $systemNode, $env:MESA_TEST_PINNED_DIR | Out-Null
  Set-Content (Join-Path $systemNode 'node.cmd') '@echo v20.0.0'
  Set-Content (Join-Path $env:MESA_TEST_PINNED_DIR 'node.cmd') '@echo v22.22.3'
  $orderProbe = Join-Path $temporary 'node-order.cmd'
  $orderBody = "@echo off`r`nsetlocal disabledelayedexpansion`r`nset `"MESA_NODE_VERSION=22.22.3`"`r`nset `"NODE_BIN=$systemNode`"`r`nif `"%MESA_TEST_ACTIVATE%`"==`"1`" call :use_pinned_node`r`ncall :refresh_paths`r`ncall :refresh_paths`r`ncall :require_pinned_node`r`nexit /b %errorlevel%`r`n" + ($runScript.Substring($useAt + 1, $useEnd - $useAt - 1) -replace "`r?`n", "`r`n")
  Set-Content -Path $orderProbe -Value $orderBody
  foreach ($case in @(@('1', 0), @('0', 1))) {
    $env:MESA_TEST_ACTIVATE = $case[0]
    $status = Invoke-Cmd "`"$orderProbe`""
    Assert-True ($status -eq $case[1]) "pinned Node order check returned $status (activated: $($case[0]))"
  }
  Remove-Item Env:\MESA_TEST_ACTIVATE -ErrorAction SilentlyContinue
  $env:Path = $priorPath

  # Extract one labelled subroutine (up to the next top-level label).
  function Get-Subroutine([string]$label, [string]$next) {
    $at = $runScript.IndexOf("`n:$label")
    $end = $runScript.IndexOf("`n:$next", $at + 1)
    Assert-True ($at -ge 0 -and $end -gt $at) "run.cmd subroutine :$label is missing"
    return ($runScript.Substring($at + 1, $end - $at - 1) -replace "`r?`n", "`r`n")
  }
  # The build stamp keeps "!" and "&" in the folder path, and a case-only
  # difference in the stamped path keeps the Rust cache.
  Assert-True ($runScript -match '(?m)^setlocal disabledelayedexpansion\r?$') 'run.cmd enables delayed expansion for the whole script'
  $oddFolder = Join-Path $temporary 'Mesa !bang & co'
  New-Item -ItemType Directory -Force (Join-Path $oddFolder 'src-tauri\target') | Out-Null
  $stampProbe = Join-Path $temporary 'stamp-probe.cmd'
  $stampBody = "@echo off`r`nsetlocal disabledelayedexpansion`r`ncd /d `"%MESA_TEST_STAMP_DIR%`"`r`nset `"STAMP=src-tauri\.build-cache-path`"`r`nif `"%MESA_TEST_STAMP_CASE%`"==`"1`" call :checkmoved`r`ncall :write_build_stamp`r`nexit /b 0`r`n" + (Get-Subroutine 'checkmoved' 'check_long_paths') + "`r`n"
  Set-Content -Path $stampProbe -Value $stampBody
  $env:MESA_TEST_STAMP_DIR = $oddFolder
  $env:MESA_TEST_STAMP_CASE = '0'
  $status = Invoke-Cmd "`"$stampProbe`""
  Assert-True ($status -eq 0) "build stamp probe failed: $global:mesaCmdOutput"
  $stamp = Join-Path $oddFolder 'src-tauri\.build-cache-path'
  Assert-True ((Get-Content -Raw $stamp).Trim() -ieq $oddFolder) "build stamp lost path characters: $(Get-Content -Raw $stamp)"
  Set-Content -Path $stamp -Value $oddFolder.ToUpperInvariant()
  $env:MESA_TEST_STAMP_CASE = '1'
  $status = Invoke-Cmd "`"$stampProbe`""
  Assert-True ($status -eq 0) "case-only stamp probe failed: $global:mesaCmdOutput"
  Assert-True (Test-Path (Join-Path $oddFolder 'src-tauri\target')) 'a case-only path difference cleared the Rust cache'
  Set-Content -Path $stamp -Value (Join-Path $temporary 'moved elsewhere')
  $status = Invoke-Cmd "`"$stampProbe`""
  Assert-True (-not (Test-Path (Join-Path $oddFolder 'src-tauri\target'))) 'a moved project kept the stale Rust cache'
  Remove-Item Env:\MESA_TEST_STAMP_DIR, Env:\MESA_TEST_STAMP_CASE -ErrorAction SilentlyContinue

  # Build Tools setup never reboots: --norestart, and a restart code stops setup.
  $fakeBin = Join-Path $temporary 'fake bin'
  New-Item -ItemType Directory -Force $fakeBin | Out-Null
  Set-Content (Join-Path $fakeBin 'winget.cmd') "@echo off`r`n>>`"%MESA_TEST_WINGET_LOG%`" echo %*`r`nexit /b %MESA_TEST_WINGET_STATUS%"
  $buildProbe = Join-Path $temporary 'build-tools-probe.cmd'
  Set-Content -Path $buildProbe -Value ("@echo off`r`nsetlocal disabledelayedexpansion`r`ncall :install_build_tools`r`nexit /b %errorlevel%`r`n" + (Get-Subroutine 'install_build_tools' 'install_pinned_node') + "`r`n")
  $env:MESA_TEST_WINGET_LOG = Join-Path $temporary 'winget.log'
  $env:Path = "$fakeBin;$(Join-Path $env:SystemRoot 'System32')"
  # 0x8A15010A (-1978334966) means a restart is needed before anything installs.
  $installed = 'were installed, but Windows must restart'
  $nothing = 'Windows must restart before Microsoft C++ Build Tools can be installed. Nothing was installed.'
  foreach ($case in @(@('0', 0, ''), @('1', 0, ''), @('3010', 1, $installed), @('1641', 1, $installed), @('-1978334967', 1, $installed), @('-1978334966', 1, $nothing))) {
    Remove-Item $env:MESA_TEST_WINGET_LOG -ErrorAction SilentlyContinue
    $env:MESA_TEST_WINGET_STATUS = $case[0]
    $status = Invoke-Cmd "`"$buildProbe`""
    Assert-True ($status -eq $case[1]) "Build Tools install returned $status for winget status $($case[0])"
    Assert-True ((Get-Content -Raw $env:MESA_TEST_WINGET_LOG) -match '--quiet --wait --norestart ') 'Build Tools install may restart Windows'
    if ($case[2]) { Assert-True ($global:mesaCmdOutput.Contains($case[2])) "winget status $($case[0]) said: $global:mesaCmdOutput" }
    if ($case[2] -eq $nothing) { Assert-True (-not $global:mesaCmdOutput.Contains($installed)) 'a restart-before-install claimed the tools were installed' }
  }

  # A cl.exe that targets x86 or ARM64 is not accepted as the x64 toolchain.
  Set-Content (Join-Path $fakeBin 'cl.cmd') "@echo off`r`n1>&2 echo Microsoft (R) C/C++ Optimizing Compiler Version 19.40.33811 for %MESA_TEST_CL_ARCH%`r`necho usage: cl [ option... ] filename... [ /link linkoption... ]`r`nexit /b 0"
  $clProbe = Join-Path $temporary 'cl-probe.cmd'
  Set-Content -Path $clProbe -Value ("@echo off`r`nsetlocal disabledelayedexpansion`r`ncall :has_msvc_tools`r`nexit /b %errorlevel%`r`n" + (Get-Subroutine 'has_msvc_tools' 'install_build_tools') + "`r`n")
  ${env:ProgramFiles(x86)} = $temporary
  foreach ($case in @(@('x64', '', 0), @('x86', '', 1), @('ARM64', '', 1), @('x64', 'x86', 1))) {
    $env:MESA_TEST_CL_ARCH = $case[0]
    if ($case[1]) { $env:VSCMD_ARG_TGT_ARCH = $case[1] } else { Remove-Item Env:\VSCMD_ARG_TGT_ARCH -ErrorAction SilentlyContinue }
    $status = Invoke-Cmd "`"$clProbe`""
    Assert-True ($status -eq $case[2]) "cl for $($case[0]) (VSCMD target '$($case[1])') returned $status"
  }
  Remove-Item Env:\VSCMD_ARG_TGT_ARCH, Env:\MESA_TEST_CL_ARCH, Env:\MESA_TEST_WINGET_LOG, Env:\MESA_TEST_WINGET_STATUS -ErrorAction SilentlyContinue
  ${env:ProgramFiles(x86)} = $priorProgramFilesX86
  $env:Path = $priorPath

  # Failure cases intentionally leave a nonzero native command status.
  # Clear it only after every assertion passes so callers see the suite result.
  $global:LASTEXITCODE = 0
  Write-Output 'Windows installer behavior passed.'
} finally {
  Set-Location $priorDirectory
  $env:MESA_DIR = $priorMesaDir
  $env:MESA_TEST_LAUNCH = $priorLaunchLog
  $env:Path = $priorPath
  $env:ProgramFiles = $priorProgramFiles
  ${env:ProgramFiles(x86)} = $priorProgramFilesX86
  $env:LOCALAPPDATA = $priorLocalAppData
  $env:PSModulePath = $priorModulePath
  Remove-Item Env:\MESA_TEST_MODULE_PATH, Env:\MESA_TEST_NODE_HASH, Env:\MESA_TEST_NODE_FAIL, Env:\MESA_TEST_PINNED_DIR, Env:\MESA_TEST_NODE_LOG, Env:\MESA_TEST_PINNED_FAIL -ErrorAction SilentlyContinue
  Remove-Item Function:\git -ErrorAction SilentlyContinue
  Remove-Variable -Name mesaGitCalls, mesaHasChanges, mesaMergeFails, mesaSignatureFails, mesaAhead, mesaSignatureOutput, mesaSigners, mesaPinnedSignature, mesaCmdOutput, mesaGitVersion -Scope Global -ErrorAction SilentlyContinue
  Remove-Item -Recurse -Force $temporary -ErrorAction SilentlyContinue
}
