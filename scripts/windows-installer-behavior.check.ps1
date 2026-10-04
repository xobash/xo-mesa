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

function Assert-True([bool]$condition, [string]$message) {
  if (-not $condition) { throw $message }
}

function global:git {
  $call = @($args) -join ' '
  $global:mesaGitCalls += $call
  $global:LASTEXITCODE = 0
  if ($call -match '\bstatus\b') {
    if ($global:mesaHasChanges) { Write-Output ' M note.md' }
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
  Assert-True ($calls -match 'fetch origin main') 'origin was not fetched'
  Assert-True ($calls -match 'merge --ff-only origin/main') 'update was not limited to fast-forward'
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

  $runScript = Get-Content -Raw (Join-Path $project 'run.cmd')
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
  Write-Output 'Windows installer behavior passed.'
} finally {
  Set-Location $priorDirectory
  $env:MESA_DIR = $priorMesaDir
  $env:MESA_TEST_LAUNCH = $priorLaunchLog
  $env:Path = $priorPath
  $env:ProgramFiles = $priorProgramFiles
  ${env:ProgramFiles(x86)} = $priorProgramFilesX86
  $env:LOCALAPPDATA = $priorLocalAppData
  Remove-Item Function:\git -ErrorAction SilentlyContinue
  Remove-Variable -Name mesaGitCalls, mesaHasChanges, mesaMergeFails -Scope Global -ErrorAction SilentlyContinue
  Remove-Item -Recurse -Force $temporary -ErrorAction SilentlyContinue
}
