<#
  Installs the Ageless Tally connector as a Windows service with NSSM (https://nssm.cc, a free service wrapper:
  Node cannot register itself as a service). Run in an elevated PowerShell on the Tally server PC, from the deployed folder.

  .\scripts\install-service.ps1 -ApiUrl https://api.example.com/api -ClientId mc_xxxx -SecretFile C:\ProgramData\AgelessTallyConnector\secret.txt

  Nothing here opens a port. The service runs as LocalService, which can read only what you give it.
#>
param(
  [Parameter(Mandatory)][string]$ApiUrl,
  [Parameter(Mandatory)][string]$ClientId,
  [Parameter(Mandatory)][string]$SecretFile,
  [string]$TallyUrl = 'http://localhost:9000',
  [string]$ServiceName = 'AgelessTallyConnector',
  [string]$DataDir = 'C:\ProgramData\AgelessTallyConnector',
  [string]$Nssm = 'nssm.exe',
  [string]$Node = (Get-Command node.exe).Source
)
$ErrorActionPreference = 'Stop'
$app = Split-Path -Parent $PSScriptRoot
if (-not (Test-Path (Join-Path $app 'dist\main.js'))) { throw "dist\main.js not found in $app: deploy a built connector first (see README)." }
if (-not (Test-Path $SecretFile)) { throw "Secret file $SecretFile not found. Create it with the secret and nothing else." }
if ($ApiUrl -notmatch '^https://') { throw 'The API address must start with https://' }

New-Item -ItemType Directory -Force -Path $DataDir | Out-Null
# Only the service account and administrators may read the data folder (the secret file, the state file, the logs).
icacls $DataDir /inheritance:r /grant:r 'NT AUTHORITY\LOCAL SERVICE:(OI)(CI)M' 'BUILTIN\Administrators:(OI)(CI)F' | Out-Null
icacls $SecretFile /inheritance:r /grant:r 'NT AUTHORITY\LOCAL SERVICE:R' 'BUILTIN\Administrators:F' | Out-Null

& $Nssm install $ServiceName $Node (Join-Path $app 'dist\main.js')
& $Nssm set $ServiceName AppDirectory $app
& $Nssm set $ServiceName DisplayName 'Ageless Tally connector'
& $Nssm set $ServiceName Description 'Posts approved Ageless batches to Tally on this PC. Only calls out; opens no port.'
& $Nssm set $ServiceName ObjectName 'NT AUTHORITY\LocalService'
& $Nssm set $ServiceName Start SERVICE_AUTO_START
& $Nssm set $ServiceName AppEnvironmentExtra "ATPL_API_URL=$ApiUrl" "CONNECTOR_CLIENT_ID=$ClientId" "CONNECTOR_SECRET_FILE=$SecretFile" "TALLY_URL=$TallyUrl" "STATE_FILE=$DataDir\connector-state.json"
& $Nssm set $ServiceName AppStdout (Join-Path $DataDir 'connector.log')
& $Nssm set $ServiceName AppStderr (Join-Path $DataDir 'connector.log')
& $Nssm set $ServiceName AppRotateFiles 1
& $Nssm set $ServiceName AppRotateBytes 5242880
& $Nssm set $ServiceName AppExit Default Restart
& $Nssm set $ServiceName AppRestartDelay 30000
Write-Host "Installed. Start it with:  nssm start $ServiceName   (log: $DataDir\connector.log)"
