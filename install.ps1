# Mesa - one-command Windows bootstrap, designed to be run as:
#   irm https://raw.githubusercontent.com/xobash/xo-mesa/main/install.ps1 | iex
#
# `iex` executes this text INSIDE the caller's PowerShell runspace (unlike
# `curl | bash`, which forks a child shell). That has two consequences this
# script must respect or it will wreck the user's session:
#   1. A top-level `exit` terminates the USER'S PowerShell window (it looks
#      like PowerShell crashed). Never `exit` here - `return` out of the block.
#   2. Bare functions and `$ErrorActionPreference` would leak into the
#      interactive session. Scoping everything inside one `& { ... }` block
#      keeps them local and disposable.
& {
  $ErrorActionPreference = "Stop"

  $repoUrl = "https://github.com/xobash/xo-mesa.git"
  $currentDir = Get-Location
  $installDir = if ($env:MESA_DIR) {
    [System.IO.Path]::GetFullPath($env:MESA_DIR)
  } elseif ((Split-Path $currentDir -Leaf) -eq "xo-mesa" -and (Test-Path (Join-Path $currentDir ".git"))) {
    [string]$currentDir
  } else {
    Join-Path $currentDir "xo-mesa"
  }

  function Add-PathIfExists {
    param([string]$PathToAdd)
    if ((Test-Path $PathToAdd) -and -not (($env:Path -split [System.IO.Path]::PathSeparator) -contains $PathToAdd)) {
      $env:Path = "$PathToAdd$([System.IO.Path]::PathSeparator)$env:Path"
    }
  }

  function Refresh-MesaBootstrapPath {
    Add-PathIfExists (Join-Path $env:USERPROFILE "scoop\shims")
    Add-PathIfExists (Join-Path $env:ProgramFiles "Git\cmd")
    Add-PathIfExists (Join-Path $env:ProgramFiles "nodejs")
    Add-PathIfExists (Join-Path $env:USERPROFILE ".cargo\bin")
  }

  function Ensure-Git {
    Refresh-MesaBootstrapPath
    if (Get-Command git -ErrorAction SilentlyContinue) {
      return
    }

    if (-not (Get-Command winget -ErrorAction SilentlyContinue)) {
      throw "Git is required, and winget is not available to install it automatically. Install Git, then rerun the Mesa install command."
    }

    Write-Host "Installing Git via winget..."
    winget install --id Git.Git -e --accept-source-agreements --accept-package-agreements
    Refresh-MesaBootstrapPath

    if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
      throw "Git was installed, but this PowerShell session cannot find it yet. Open a new PowerShell window and rerun the Mesa install command."
    }
  }

  Ensure-Git

  if (Test-Path (Join-Path $installDir ".git")) {
    Write-Host "Updating Mesa in $installDir..."
    git -C $installDir pull --ff-only
  } elseif (Test-Path $installDir) {
    throw "The target folder exists but is not a Git checkout: $installDir. Move it aside or set MESA_DIR to another folder."
  } else {
    Write-Host "Cloning Mesa into $installDir..."
    git clone $repoUrl $installDir
  }

  Set-Location $installDir
  # Hand off to the full setup+launch script. Do NOT `exit` afterward: under
  # `iex` that would close the user's PowerShell window. run.cmd's exit code
  # remains in $LASTEXITCODE for anyone who wants to inspect it.
  & .\run.cmd
}
