# Install the AMA status adapter on a Windows machine and let ssh forward the
# pane's surface token into the remote session.
#
# Two halves:
#   1. sshd must accept AMA_SURFACE_TOKEN and ALL_MY_AGENTS_URL, otherwise the
#      forwarded environment never reaches the remote shell.
#   2. Claude Code must run the adapter as a hook, so the remote agent reports
#      its status and session id back to the machine running AMA.
#
# Run this from an Administrator PowerShell, over SSH.

$ErrorActionPreference = 'Stop'

$AdapterSource = $args[0]          # path to ama-status-hook.js on this machine
$AdapterDest   = Join-Path $env:USERPROFILE 'ama\ama-status-hook.js'
$NodeExe       = 'C:\Program Files\nodejs\node.exe'
$ClaudeDir     = Join-Path $env:USERPROFILE '.claude'
$SettingsPath  = Join-Path $ClaudeDir 'settings.json'
$SshdConfig    = 'C:\ProgramData\ssh\sshd_config'

Write-Host "=== AMA adapter install ==="

# --- 1. sshd AcceptEnv -----------------------------------------------------
if (-not (Test-Path $SshdConfig)) { throw "sshd_config not found at $SshdConfig" }
$lines = Get-Content $SshdConfig
$clean = @($lines | Where-Object { $_ -notmatch '^\s*AcceptEnv\s+AMA_SURFACE_TOKEN' })
$insertAt = $clean.Count
for ($i = 0; $i -lt $clean.Count; $i++) {
    if ($clean[$i] -match '^\s*Match\s') { $insertAt = $i; break }
}
if ($insertAt -lt 1) { $insertAt = [Math]::Min(1, $clean.Count) }
$head = if ($insertAt -gt 0) { $clean[0..($insertAt - 1)] } else { @() }
$tail = if ($insertAt -lt $clean.Count) { $clean[$insertAt..($clean.Count - 1)] } else { @() }
$new = @($head) + @('# AMA: let a forwarded pane token reach the remote session', 'AcceptEnv AMA_SURFACE_TOKEN ALL_MY_AGENTS_URL') + @($tail)
[System.IO.File]::WriteAllLines($SshdConfig, $new)
Write-Host "AcceptEnv added to sshd_config above the first Match block"

# sshd reads its config once at startup, so it must be restarted. Restarting
# drops the SSH connection we are running over, so the restart is scheduled
# as a one-shot task instead of run inline.
$restartScript = Join-Path $env:TEMP 'ama-restart-sshd.ps1'
Set-Content -Path $restartScript -Value 'Restart-Service sshd -Force' -Encoding ascii
# schtasks takes a wall-clock HH:mm, so the time has to round up to a minute
# that is still in the future. Twenty seconds can round into the past.
$when = (Get-Date).AddSeconds(70).ToString('HH:mm')
schtasks /create /tn "AMA-Restart-SSHD" /sc once /st $when /tr "powershell.exe -NoProfile -ExecutionPolicy Bypass -File `"$restartScript`"" /f | Out-Null
Write-Host "sshd restart scheduled at $when"

# --- 1b. where the far side reports status ---------------------------------
# The ssh client forwards only ONE environment variable per connection, so the
# base url cannot ride along with the surface token. Where an agent reports to
# is a property of the machine, not of a session, so it belongs in the user
# environment and every session on this machine inherits it.
$BaseUrl = if ($args[1]) { $args[1] } else { 'http://192.168.64.1:3456' }
[Environment]::SetEnvironmentVariable('ALL_MY_AGENTS_URL', $BaseUrl, 'User')
Write-Host "ALL_MY_AGENTS_URL = $BaseUrl (user environment)"

# --- 2. the adapter script -------------------------------------------------
if (-not $AdapterSource -or -not (Test-Path $AdapterSource)) { throw "adapter source not found: $AdapterSource" }
New-Item -ItemType Directory -Force -Path (Split-Path $AdapterDest) | Out-Null
Copy-Item -Path $AdapterSource -Destination $AdapterDest -Force
Write-Host "adapter installed -> $AdapterDest"

if (-not (Test-Path $NodeExe)) { throw "node not found at $NodeExe" }

# --- 3. Claude Code hook wiring -------------------------------------------
# Windows cannot execute .cmd/.bat shims directly, so the hook is wired in
# exec form against the real node.exe.
# Windows paths are full of backslashes, which are not valid JSON escapes, so
# the hooks are built as objects and serialised rather than written as JSON.
$hookDef = [pscustomobject]@{ type = 'command'; command = $NodeExe; args = @($AdapterDest) }
$hooks = [pscustomobject]@{
    SessionStart     = @([pscustomobject]@{ hooks = @($hookDef) })
    UserPromptSubmit = @([pscustomobject]@{ hooks = @($hookDef) })
    PreToolUse       = @([pscustomobject]@{ matcher = '*'; hooks = @($hookDef) })
    PostToolUse      = @([pscustomobject]@{ matcher = '*'; hooks = @($hookDef) })
    Notification     = @([pscustomobject]@{ hooks = @($hookDef) })
    Stop             = @([pscustomobject]@{ hooks = @($hookDef) })
    SessionEnd       = @([pscustomobject]@{ hooks = @($hookDef) })
}

New-Item -ItemType Directory -Force -Path $ClaudeDir | Out-Null
if (Test-Path $SettingsPath) {
    Copy-Item -Path $SettingsPath -Destination "$SettingsPath.bak" -Force
    $settings = Get-Content $SettingsPath -Raw | ConvertFrom-Json
    Write-Host "existing settings.json merged (backup at settings.json.bak)"
} else {
    $settings = [pscustomobject]@{}
    Write-Host "no existing settings.json - creating one"
}
if (-not $settings.PSObject.Properties['hooks']) {
    $settings | Add-Member -NotePropertyName hooks -NotePropertyValue ([pscustomobject]@{})
}
foreach ($prop in $hooks.PSObject.Properties) {
    if ($settings.hooks.PSObject.Properties.Name -contains $prop.Name) {
        $settings.hooks.PSObject.Properties[$prop.Name].Value = $prop.Value
    } else {
        $settings.hooks | Add-Member -NotePropertyName $prop.Name -NotePropertyValue $prop.Value
    }
}
# No BOM: Claude Code parses this file as JSON.
$json = $settings | ConvertTo-Json -Depth 20
[System.IO.File]::WriteAllText($SettingsPath, $json, (New-Object System.Text.UTF8Encoding($false)))
Write-Host "hooks written -> $SettingsPath"

Write-Host "=== AMA_ADAPTER_READY ==="
