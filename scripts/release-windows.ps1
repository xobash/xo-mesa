$ErrorActionPreference = 'Stop'
Set-Location (Split-Path $PSScriptRoot -Parent)
foreach ($name in @('WINDOWS_CERTIFICATE_BASE64', 'WINDOWS_CERTIFICATE_PASSWORD', 'WINDOWS_SIGNING_THUMBPRINT')) {
  if (-not [Environment]::GetEnvironmentVariable($name)) { throw "Missing protected signing input: $name" }
}
$pfx = Join-Path ([IO.Path]::GetTempPath()) ("mesa-signing-" + [guid]::NewGuid().ToString('N') + '.pfx')
$config = Join-Path ([IO.Path]::GetTempPath()) ("mesa-signing-" + [guid]::NewGuid().ToString('N') + '.json')
$certificate = $null
try {
  [IO.File]::WriteAllBytes($pfx, [Convert]::FromBase64String($env:WINDOWS_CERTIFICATE_BASE64))
  $password = ConvertTo-SecureString $env:WINDOWS_CERTIFICATE_PASSWORD -AsPlainText -Force
  $certificate = Import-PfxCertificate -FilePath $pfx -CertStoreLocation Cert:\CurrentUser\My -Password $password
  if ($certificate.Thumbprint -ne $env:WINDOWS_SIGNING_THUMBPRINT -or -not $certificate.HasPrivateKey) { throw 'Signing identity mismatch' }
  @{ bundle = @{ windows = @{ certificateThumbprint = $certificate.Thumbprint; digestAlgorithm = 'sha256'; timestampUrl = 'https://timestamp.digicert.com'; tsp = $true } } } | ConvertTo-Json -Depth 5 | Set-Content $config
  & npm run mesa:build -- --bundles msi,nsis --config $config
  if ($LASTEXITCODE -ne 0) { throw 'Windows release build failed' }
  $msi = @(Get-ChildItem src-tauri/target/release/bundle/msi -Filter '*.msi')
  $nsis = @(Get-ChildItem src-tauri/target/release/bundle/nsis -Filter '*.exe')
  if ($msi.Count -ne 1 -or $nsis.Count -ne 1) { throw 'Expected exactly one MSI and one NSIS installer' }
  foreach ($file in @($msi[0].FullName, $nsis[0].FullName, (Resolve-Path src-tauri/target/release/mesa.exe).Path)) {
    $signature = Get-AuthenticodeSignature -LiteralPath $file
    if ($signature.Status -ne 'Valid' -or $signature.SignerCertificate.Thumbprint -ne $env:WINDOWS_SIGNING_THUMBPRINT -or -not $signature.TimeStamperCertificate) { throw "Invalid signed product: $file" }
  }
} finally {
  Remove-Item $pfx, $config -Force -ErrorAction SilentlyContinue
  if ($certificate) { Remove-Item "Cert:\CurrentUser\My\$($certificate.Thumbprint)" -Force -ErrorAction SilentlyContinue }
}
