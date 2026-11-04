# Only the container name is needed; the caller removes inherited signing credentials.
$ErrorActionPreference = 'Stop'
Add-Type -Path (Join-Path $PSScriptRoot 'windows-token-public-key.cs')
[OndraTokenPublicKey]::Read([OndraTokenPublicKey+NativeApi]::new(), $env:ONDRA_TOKEN_PUBLIC_CONTAINER) | ConvertTo-Json -Compress
