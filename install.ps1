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

  # Windows caps paths at 260 characters unless LongPathsEnabled is set
  # machine-wide, and Git enforces that cap on its own unless core.longpaths is
  # on. Passed with `-c` so it applies to this checkout only - never edit the
  # user's global Git config from an install script. run.cmd separately warns
  # when the same limit threatens the Rust build, which reaches much deeper.
  $gitLongPaths = @("-c", "core.longpaths=true")

  if (Test-Path (Join-Path $installDir ".git")) {
    Write-Host "Updating Mesa in $installDir..."
    # A normal `git pull --ff-only` refuses to update when the person using
    # Mesa has edited source files locally. Preserve that work first, update
    # only by a fast-forward (never rewrite or merge their local commits), and
    # put their files back before Mesa launches.
    $localChanges = & git @gitLongPaths -C $installDir status --porcelain --untracked-files=all
    if ($LASTEXITCODE -ne 0) {
      throw "Could not inspect local Mesa changes. No update was applied."
    }

    $preservedStash = $null
    if (-not [string]::IsNullOrWhiteSpace($localChanges)) {
      Write-Host "Preserving local Mesa changes before updating..."
      & git @gitLongPaths -C $installDir stash push --include-untracked --message "Mesa bootstrap preserved local work"
      if ($LASTEXITCODE -ne 0) {
        throw "Could not preserve local Mesa changes. No update was applied."
      }
      $preservedStash = [string](& git @gitLongPaths -C $installDir rev-parse -q --verify refs/stash)
      if ([string]::IsNullOrWhiteSpace($preservedStash)) {
        throw "Could not confirm the preserved local Mesa changes. No update was applied."
      }
      $preservedStash = $preservedStash.Trim()
    }

    try {
      & git @gitLongPaths -C $installDir fetch origin main
      if ($LASTEXITCODE -ne 0) {
        throw "Could not download Mesa updates."
      }
      & git @gitLongPaths -C $installDir merge --ff-only origin/main
      if ($LASTEXITCODE -ne 0) {
        throw "Mesa has local commits or old checkout history that cannot fast-forward from GitHub. No source update was applied, and nothing was pushed."
      }
    } catch {
      if ($preservedStash) {
        & git @gitLongPaths -C $installDir stash pop $preservedStash
      }
      throw
    }

    if ($preservedStash) {
      Write-Host "Restoring local Mesa changes..."
      & git @gitLongPaths -C $installDir stash pop $preservedStash
      if ($LASTEXITCODE -ne 0) {
        throw "Mesa was updated, but restoring local changes needs conflict resolution. Your work remains in the checkout and in Git's stash. Resolve the conflicts before launching Mesa."
      }
    }
  } elseif (Test-Path $installDir) {
    throw "The target folder exists but is not a Git checkout: $installDir. Move it aside or set MESA_DIR to another folder."
  } else {
    Write-Host "Cloning Mesa into $installDir..."
    git @gitLongPaths clone $repoUrl $installDir
  }

  Set-Location $installDir
  # Hand off to the full setup+launch script. Do NOT `exit` afterward: under
  # `iex` that would close the user's PowerShell window. run.cmd's exit code
  # remains in $LASTEXITCODE for anyone who wants to inspect it.
  & .\run.cmd
}
