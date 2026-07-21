$ErrorActionPreference = 'Stop'

if ([string]::IsNullOrWhiteSpace($env:WINDOWS_CERTIFICATE)) {
  throw 'WINDOWS_CERTIFICATE is required for Windows release signing.'
}
if ([string]::IsNullOrWhiteSpace($env:WINDOWS_CERTIFICATE_PASSWORD)) {
  throw 'WINDOWS_CERTIFICATE_PASSWORD is required for Windows release signing.'
}
if ([string]::IsNullOrWhiteSpace($env:GITHUB_ENV)) {
  throw 'GITHUB_ENV is required to publish the imported certificate thumbprint.'
}

$certificatePath = Join-Path $env:RUNNER_TEMP 'pebble-windows-release.pfx'
try {
  [IO.File]::WriteAllBytes(
    $certificatePath,
    [Convert]::FromBase64String($env:WINDOWS_CERTIFICATE)
  )
  $password = ConvertTo-SecureString $env:WINDOWS_CERTIFICATE_PASSWORD -AsPlainText -Force
  $certificate = Import-PfxCertificate `
    -FilePath $certificatePath `
    -CertStoreLocation 'Cert:\CurrentUser\My' `
    -Password $password `
    -Exportable:$false

  if (-not $certificate.HasPrivateKey) {
    throw 'Imported Windows release certificate has no private key.'
  }
  $codeSigningOid = '1.3.6.1.5.5.7.3.3'
  $canSignCode = $certificate.EnhancedKeyUsageList.ObjectId.Value -contains $codeSigningOid
  if (-not $canSignCode) {
    throw 'Imported Windows release certificate is not valid for code signing.'
  }
  if ($certificate.NotAfter -le [DateTime]::UtcNow) {
    throw 'Imported Windows release certificate is expired.'
  }

  "TAURI_WINDOWS_CERTIFICATE_THUMBPRINT=$($certificate.Thumbprint)" | Out-File `
    -FilePath $env:GITHUB_ENV `
    -Encoding utf8 `
    -Append
} finally {
  Remove-Item $certificatePath -Force -ErrorAction SilentlyContinue
}
