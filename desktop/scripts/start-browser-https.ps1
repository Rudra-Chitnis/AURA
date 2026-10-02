$ErrorActionPreference = "Stop"

$desktopRoot = Split-Path -Parent $PSScriptRoot
$certDirectory = Join-Path $desktopRoot "certs"
$pfxPath = Join-Path $certDirectory "aura-localhost.pfx"
$cerPath = Join-Path $certDirectory "aura-localhost.cer"

New-Item -ItemType Directory -Force -Path $certDirectory | Out-Null

$emptyPassword = ConvertTo-SecureString -String "" -Force -AsPlainText
$certificateData = $null
if ((Test-Path -LiteralPath $pfxPath) -and (Test-Path -LiteralPath $cerPath)) {
  try { $certificateData = Get-PfxData -FilePath $pfxPath -Password $emptyPassword } catch { $certificateData = $null }
  if ($certificateData -and $certificateData.EndEntityCertificates[0].NotAfter -le (Get-Date)) { $certificateData = $null }
}

if (-not $certificateData) {
  $certificate = New-SelfSignedCertificate `
    -DnsName "localhost" `
    -CertStoreLocation "Cert:\CurrentUser\My" `
    -Type SSLServerAuthentication `
    -KeyAlgorithm RSA `
    -KeyLength 2048 `
    -NotAfter (Get-Date).AddYears(2) `
    -FriendlyName "AURA local browser development"

  Export-PfxCertificate -Cert $certificate -FilePath $pfxPath -Password $emptyPassword | Out-Null
  Export-Certificate -Cert $certificate -FilePath $cerPath | Out-Null
  $certificateData = Get-PfxData -FilePath $pfxPath -Password $emptyPassword
  Write-Host "Created a localhost-only AURA development certificate."
}

$thumbprint = $certificateData.EndEntityCertificates[0].Thumbprint
$trusted = Get-ChildItem "Cert:\CurrentUser\Root" | Where-Object { $_.Thumbprint -eq $thumbprint }
if (-not $trusted) {
  Import-Certificate -FilePath $cerPath -CertStoreLocation "Cert:\CurrentUser\Root" | Out-Null
  Write-Host "Trusted the AURA localhost certificate for the current Windows user."
}

$env:AURA_DEV_TLS_PFX = $pfxPath
Push-Location $desktopRoot
try {
  npm exec -- vite --host localhost
} finally {
  Pop-Location
}
