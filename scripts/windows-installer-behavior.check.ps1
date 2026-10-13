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

function Assert-True([bool]$condition, [string]$message) {
  if (-not $condition) { throw $message }
}

function global:git {
  $call = @($args) -join ' '
  $global:mesaGitCalls += $call
  $global:LASTEXITCODE = 0
  if ($call -match 'remote get-url origin') { Write-Output 'https://github.com/xobash/xo-mesa.git'
  } elseif ($call -match '\bstatus\b') {
    if ($global:mesaHasChanges) { Write-Output ' M note.md' }
  } elseif ($call -match 'verify-tag' -and $global:mesaSignatureFails) {
    $global:LASTEXITCODE = 1
  } elseif ($call -match 'rev-parse HEAD' -and $global:mesaAhead) {
    Write-Output 'ahead'
  } elseif ($call -match '\brev-parse\b') {
    Write-Output 'abc123'
  } elseif ($call -match '\bmerge\b' -and $global:mesaMergeFails) {
    $global:LASTEXITCODE = 1
  } elseif ($call -match '\bclone\b') {
    New-Item -ItemType Directory -Force (Join-Path $checkout '.git') | Out-Null
    Copy-Item $runner (Join-Path $checkout 'run.cmd')
  }
}

try {
  New-Item -ItemType Directory -Force $temporary | Out-Null
  Set-Content -Path $runner -Value "@echo off`r`n>>`"%MESA_TEST_LAUNCH%`" echo launched" -NoNewline
  $env:MESA_DIR = $checkout
  $env:MESA_TEST_LAUNCH = $launchLog

  $global:mesaGitCalls = @()
  $global:mesaHasChanges = $false
  $global:mesaMergeFails = $false
  $global:mesaSignatureFails = $false
  $global:mesaAhead = $false
  Invoke-Expression (Get-Content -Raw (Join-Path $project 'install.ps1'))
  Assert-True (Test-Path $launchLog) 'fresh clone did not launch Mesa'
  Assert-True (($global:mesaGitCalls -join "`n") -match '\bclone\b') 'fresh checkout was not cloned'

  Set-Location $temporary
  Remove-Item $launchLog
  $global:mesaGitCalls = @()
  $global:mesaHasChanges = $true
  Invoke-Expression (Get-Content -Raw (Join-Path $project 'install.ps1'))
  $calls = $global:mesaGitCalls -join "`n"
  Assert-True ($calls -match 'stash push --include-untracked') 'local changes were not preserved'
  Assert-True ($calls -match 'fetch --no-tags origin refs/tags/v0.1.0:refs/tags/v0.1.0') 'origin was not fetched'
  Assert-True ($calls -match 'merge --ff-only refs/tags/v0.1.0') 'update was not limited to fast-forward'
  Assert-True ($calls -match 'stash pop abc123') 'local changes were not restored'
  Assert-True (Test-Path $launchLog) 'successful update did not launch Mesa'

  Set-Location $temporary
  Remove-Item $launchLog
  $global:mesaGitCalls = @()
  $global:mesaMergeFails = $true
  $failed = $false
  try { Invoke-Expression (Get-Content -Raw (Join-Path $project 'install.ps1')) } catch { $failed = $true }
  Assert-True $failed 'failed fast-forward was accepted'
  Assert-True (($global:mesaGitCalls -join "`n") -match 'stash pop abc123') 'failed update did not restore local changes'
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
  $expectedHash = (Get-FileHash $payload -Algorithm SHA256).Hash
  Compress-Archive $payload (Join-Path $nodeFixture 'payload.zip')
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
  & cmd.exe /d /c 'set "PSModulePath=%MESA_TEST_MODULE_PATH%"&& powershell -NoProfile -ExecutionPolicy Bypass -File scripts\windows-node.ps1' *> $null
  Assert-True ($LASTEXITCODE -ne 0) 'broken inherited module path did not reproduce the failure'
  & cmd.exe /d /c "`"$nodeRunner`"" | Out-Null
  Assert-True ($LASTEXITCODE -eq 0) 'isolated launch could not hash/extract or changed the caller module path'
  $env:MESA_TEST_NODE_FAIL = '1'
  & cmd.exe /d /c "`"$nodeRunner`"" | Out-Null
  Assert-True ($LASTEXITCODE -eq 23) 'isolated launch lost the prerequisite failure status'
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
  foreach ($case in @(@('110.0.0.0', 1), @('111.0.0.0', 0), @('120.0.0.0', 0), @('0.0.0.0', 1))) {
    $env:MESA_TEST_WEBVIEW2_VERSION = $case[0]
    & cmd.exe /d /c "`"$probe`"" | Out-Null
    Assert-True ($LASTEXITCODE -eq $case[1]) "WebView2 probe returned $LASTEXITCODE for $($case[0])"
  }
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
  Remove-Item Env:\MESA_TEST_MODULE_PATH, Env:\MESA_TEST_NODE_HASH, Env:\MESA_TEST_NODE_FAIL -ErrorAction SilentlyContinue
  Remove-Item Function:\git -ErrorAction SilentlyContinue
  Remove-Variable -Name mesaGitCalls, mesaHasChanges, mesaMergeFails, mesaSignatureFails, mesaAhead -Scope Global -ErrorAction SilentlyContinue
  Remove-Item -Recurse -Force $temporary -ErrorAction SilentlyContinue
}
