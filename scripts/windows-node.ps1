# Pinned user-local Node, shared by all Windows source launches.
$ErrorActionPreference = 'Stop'
$version = (Get-Content (Join-Path $PSScriptRoot '../.node-version') -Raw).Trim()
if ($version -ne '22.22.3') { throw 'Update reviewed Node digests when changing the toolchain.' }
$arch = if ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64') { 'arm64' } else { 'x64' }
$hashes = @{
  x64 = '6c8d54f635feff4df76c2ca80f45332eb2ff57d25226edce36592e51a177ee33'
  arm64 = '00be129a09e8872cd52d3bb8bba12412c5733d2224123a482a2dca4a6fbf2586'
}
$folder = Join-Path $env:LOCALAPPDATA 'Mesa/toolchains'
New-Item -ItemType Directory -Force $folder | Out-Null
$stage = Join-Path $folder ([guid]::NewGuid().ToString())
New-Item -ItemType Directory $stage | Out-Null
try {
  $archive = Join-Path $stage 'node.zip'
  Invoke-WebRequest "https://nodejs.org/dist/v$version/node-v$version-win-$arch.zip" -OutFile $archive -UseBasicParsing
  if ((Get-FileHash $archive -Algorithm SHA256).Hash.ToLowerInvariant() -ne $hashes[$arch]) { throw 'Node archive verification failed.' }
  Expand-Archive $archive -DestinationPath $stage
  $name = "node-v$version-win-$arch"
  $destination = Join-Path $folder $name
  if (Test-Path $destination) { Remove-Item $destination -Recurse -Force }
  Move-Item (Join-Path $stage $name) $destination
  & (Join-Path $destination 'node.exe') --version
  if ($LASTEXITCODE -ne 0) { throw 'Pinned Node cannot run.' }
} finally { Remove-Item $stage -Recurse -Force }
