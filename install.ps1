# Mesa - one-command Windows bootstrap, designed to be run as:
#   irm https://raw.githubusercontent.com/xobash/xo-mesa/v0.1.0/install.ps1 | iex
# Not available yet: no signed v0.1.0 release tag exists. The command works only
# after the first signed release; see docs/release.md for the checksum-verified form.
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
  $releaseVersion = if ($env:MESA_VERSION) { $env:MESA_VERSION } else { "v0.1.0" }
  if ($releaseVersion -notmatch '^v[0-9]+\.[0-9]+\.[0-9]+(-[A-Za-z0-9.-]+)?$') { throw "Invalid Mesa release version." }
  # Release tags must carry a signature from this maintainer identity. See
  # "Release signing identity" in docs/release.md before changing these values.
  $releaseSigner = "xobash@users.noreply.github.com"
  $releaseSshKey = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIFD4Ut8iLVnnB4ps75Fmr5gwgnHfmf+Jm+ZKZtVTr8Di"
  $releaseSshFingerprint = "SHA256:JTK3hA6m0Hr2/77nrt0wTl0n38Lrl8HuraqKbvZd3so"
  # OpenPGP fingerprints (40 uppercase hex characters); none yet.
  $releaseOpenPgpFingerprints = @()
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

  # Accept only `git verify-tag --raw` output from the pinned identity: an SSH
  # "Good" line for the pinned principal and key, or an OpenPGP VALIDSIG line
  # whose signing or primary fingerprint is pinned.
  function Test-PinnedReleaseSignature {
    param([string[]]$Lines)
    $ordinal = [System.StringComparison]::Ordinal
    foreach ($line in ($Lines -split "\r?\n")) {
      if ($line.StartsWith("Good `"git`" signature for $releaseSigner with ", $ordinal) -and $line.EndsWith(" key $releaseSshFingerprint", $ordinal)) { return $true }
      if ($line.StartsWith('[GNUPG:] VALIDSIG ', $ordinal)) {
        $fields = $line -split ' '
        if (($releaseOpenPgpFingerprints -ccontains $fields[2]) -or ($fields.Count -gt 11 -and $releaseOpenPgpFingerprints -ccontains $fields[11])) { return $true }
      }
    }
    return $false
  }

  function Assert-ReleaseTagSigned {
    $signers = [System.IO.Path]::GetTempFileName()
    $status = 1
    $raw = @()
    try {
      [System.IO.File]::WriteAllText($signers, "$releaseSigner namespaces=`"git`" $releaseSshKey`n")
      # Windows PowerShell 5.1 turns redirected native stderr into errors.
      $previousPreference = $ErrorActionPreference
      $ErrorActionPreference = "Continue"
      try {
        $raw = @(& git @gitLongPaths -C $installDir -c "gpg.ssh.allowedSignersFile=$signers" verify-tag --raw $releaseVersion 2>&1 | ForEach-Object { "$_" })
        $status = $LASTEXITCODE
      } finally {
        $ErrorActionPreference = $previousPreference
      }
    } finally {
      Remove-Item -LiteralPath $signers -Force -ErrorAction SilentlyContinue
    }
    if ($status -ne 0 -or -not (Test-PinnedReleaseSignature $raw)) {
      throw "The release tag is not signed by the Mesa release identity in docs/release.md. No code was executed."
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

    # `stash pop` accepts only a stash@{n} reference, never the commit id, so
    # apply the exact preserved commit and drop it only while it is still on top.
    function Restore-PreservedStash {
      & git @gitLongPaths -C $installDir stash apply $preservedStash | Out-Host
      if ($LASTEXITCODE -ne 0) { return $false }
      $top = [string](& git @gitLongPaths -C $installDir rev-parse -q --verify refs/stash)
      if ($top.Trim() -eq $preservedStash) { & git @gitLongPaths -C $installDir stash drop --quiet | Out-Host }
      return $true
    }

    try {
      $originUrl = & git @gitLongPaths -C $installDir remote get-url origin
      if ($LASTEXITCODE -ne 0 -or $originUrl -notin @($repoUrl, "git@github.com:xobash/xo-mesa.git")) { throw "Unexpected origin. No code was executed." }
      & git @gitLongPaths -C $installDir fetch --no-tags origin "refs/tags/${releaseVersion}:refs/tags/${releaseVersion}"
      if ($LASTEXITCODE -ne 0) {
        throw "Could not download Mesa updates."
      }
      Assert-ReleaseTagSigned
      & git @gitLongPaths -C $installDir merge --ff-only "refs/tags/$releaseVersion"
      if ($LASTEXITCODE -ne 0) {
        throw "Mesa has local commits or old checkout history that cannot fast-forward from GitHub. No source update was applied, and nothing was pushed."
      }
    } catch {
      if ($preservedStash -and -not (Restore-PreservedStash)) {
        Write-Warning "Your local Mesa changes are kept in Git's stash ($preservedStash)."
      }
      throw
    }

    if ($preservedStash) {
      Write-Host "Restoring local Mesa changes..."
      if (-not (Restore-PreservedStash)) {
        throw "Mesa was updated, but restoring local changes needs conflict resolution. Your work remains in Git's stash ($preservedStash). Resolve the conflicts before launching Mesa."
      }
    }
  } elseif (Test-Path $installDir) {
    throw "The target folder exists but is not a Git checkout: $installDir. Move it aside or set MESA_DIR to another folder."
  } else {
    Write-Host "Cloning Mesa into $installDir..."
    git @gitLongPaths clone --branch $releaseVersion --single-branch $repoUrl $installDir
    if ($LASTEXITCODE -ne 0) { throw "Could not clone the Mesa release." }
    Assert-ReleaseTagSigned
  }

  $installedCommit = & git @gitLongPaths -C $installDir rev-parse HEAD
  if ($LASTEXITCODE -ne 0) { throw "Could not inspect installed commit." }
  $releaseCommit = & git @gitLongPaths -C $installDir rev-parse "refs/tags/$releaseVersion^{commit}"
  if ($LASTEXITCODE -ne 0 -or $installedCommit -ne $releaseCommit) { throw "Checkout is ahead of the requested release. Nothing was reset; use MESA_DIR to a new empty folder." }
  Set-Location $installDir
  # Hand off to the full setup+launch script. Do NOT `exit` afterward: under
  # `iex` that would close the user's PowerShell window. run.cmd's exit code
  # remains in $LASTEXITCODE for anyone who wants to inspect it.
  & .\run.cmd
}
