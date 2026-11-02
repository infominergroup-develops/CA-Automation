# Installs the Infominer Tally sync agent to start automatically when this Windows user signs in.
# Put this file, infominer-agent.mjs and agent.json in the same folder (e.g. C:\Infominer), then run:
#   powershell -ExecutionPolicy Bypass -File C:\Infominer\install-agent.ps1
# To remove:  Unregister-ScheduledTask -TaskName "Infominer Tally Sync" -Confirm:$false

$ErrorActionPreference = 'Stop'
$dir = Split-Path -Parent $MyInvocation.MyCommand.Path
$agent = Join-Path $dir 'infominer-agent.mjs'
$config = Join-Path $dir 'agent.json'

foreach ($f in @($agent, $config)) { if (-not (Test-Path $f)) { throw "Missing $f. Download it from the portal (Tally sync > Add a Tally PC)." } }
$node = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $node) { throw 'Node.js is not installed. Install the LTS version from https://nodejs.org and run this script again.' }
$major = [int]((& $node --version).TrimStart('v').Split('.')[0])
if ($major -lt 20) { throw "Node.js $major is too old; install version 20 or newer." }

# The config file holds the agent key: only this user (and administrators) may read it.
icacls $config /inheritance:r /grant:r "$($env:USERNAME):(R,W)" "Administrators:(F)" | Out-Null

# One quick test run so problems show up now, not silently later.
Write-Host 'Testing connection to Tally and the portal...'
& $node $agent $config --once
if ($LASTEXITCODE -ne 0) { throw 'Test run failed. See agent.log in this folder.' }

$action = New-ScheduledTaskAction -Execute 'powershell.exe' -WorkingDirectory $dir `
  -Argument "-NoProfile -WindowStyle Hidden -Command & '$node' '$agent' '$config'"
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable `
  -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew
Register-ScheduledTask -TaskName 'Infominer Tally Sync' -Action $action -Trigger $trigger -Settings $settings `
  -Description 'Sends Tally books to the Infominer client portal (read-only).' -Force | Out-Null
Start-ScheduledTask -TaskName 'Infominer Tally Sync'

Write-Host 'Installed. The agent now runs whenever this user is signed in. Log file:' (Join-Path $dir 'agent.log')
