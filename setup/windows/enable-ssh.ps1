# Enable OpenSSH on the Windows host and trust the Mac's key.
#
# Gives the Mac a control channel into the VM so the rest of the setup can be
# driven remotely. Run in an ELEVATED PowerShell window:
#
#   powershell -ExecutionPolicy Bypass -File enable-ssh.ps1 -MacPublicKey '<the contents of ~/.ssh/ama_windows_ed25519.pub>'
#
# The public key is a parameter, not a constant, so no machine's key is baked
# into the repository. The script refuses to run with the placeholder in place.
#
# Prints the SSH command to run from the Mac.

param(
    # The Mac's PUBLIC ssh key (the whole line from ~/.ssh/ama_windows_ed25519.pub).
    # This is the script's ONLY parameter: a second one would silently swallow
    # any extra argument passed on the command line.
    [string]$MacPublicKey = ''
)

$ErrorActionPreference = 'Stop'

$PlaceholderKey = 'ssh-ed25519 REPLACE_WITH_YOUR_MAC_PUBLIC_KEY ama-mac-to-windows-vm'
$SshdConfig = 'C:\ProgramData\ssh\sshd_config'

$MacKey = if ($MacPublicKey) { $MacPublicKey.Trim() } else { $PlaceholderKey }
if ($MacKey -like '*REPLACE_WITH_YOUR_MAC_PUBLIC_KEY*') {
    Write-Host "=== AMA_SSH_SETUP ===" -ForegroundColor Cyan
    Write-Host "No public key supplied. Pass the Mac's public key:" -ForegroundColor Yellow
    Write-Host "  powershell -ExecutionPolicy Bypass -File enable-ssh.ps1 -MacPublicKey '`$(cat ~/.ssh/ama_windows_ed25519.pub)'" -ForegroundColor Yellow
    exit 2
}

# The Mac is the guest's default gateway, so the subnet the guest lives on is
# also the subnet the Mac sits on. Scoping the firewall rule to it keeps sshd
# unreachable from anything else that can route to this machine.
$TrustedSubnet = $env:AMA_TRUSTED_SUBNET
if (-not $TrustedSubnet) {
    $route = Get-NetRoute -DestinationPrefix '0.0.0.0/0' -ErrorAction SilentlyContinue |
        Sort-Object RouteMetric | Select-Object -First 1
    $guestAddress = Get-NetIPAddress -InterfaceIndex $route.InterfaceIndex -AddressFamily IPv4 -ErrorAction SilentlyContinue |
        Select-Object -First 1
    if ($guestAddress) {
        $TrustedSubnet = "$($guestAddress.IPAddress)/$($guestAddress.PrefixLength)"
    } else {
        $TrustedSubnet = '192.168.64.0/24'
        Write-Host "  could not detect the guest subnet, falling back to $TrustedSubnet" -ForegroundColor Yellow
    }
}

Write-Host "=== Installing OpenSSH Server ===" -ForegroundColor Cyan
try {
    $cap = Get-WindowsCapability -Online -Name 'OpenSSH.Server~~~~0.0.1.0' -ErrorAction Stop
    if ($cap.State -ne 'Installed') {
        Add-WindowsCapability -Online -Name 'OpenSSH.Server~~~~0.0.1.0' | Out-Null
        Write-Host "  installed"
    } else {
        Write-Host "  already installed"
    }
} catch {
    Write-Host "  capability install failed: $($_.Exception.Message)" -ForegroundColor Yellow
}

Write-Host "=== Installing Mac public key ===" -ForegroundColor Cyan
# Windows OpenSSH reads ~/.ssh/authorized_keys for normal accounts, but routes
# members of the Administrators group to
# C:\ProgramData\ssh\administrators_authorized_keys instead. Write both so the
# key works regardless of whether the account is elevated.
New-Item -ItemType Directory -Force -Path "$env:USERPROFILE\.ssh" | Out-Null
Set-Content -Path "$env:USERPROFILE\.ssh\authorized_keys" -Value $MacKey -Encoding ascii
icacls "$env:USERPROFILE\.ssh\authorized_keys" /inheritance:r /grant '*S-1-5-32-544:F' '*S-1-5-18:F' | Out-Null

New-Item -ItemType Directory -Force -Path 'C:\ProgramData\ssh' | Out-Null
Set-Content -Path 'C:\ProgramData\ssh\administrators_authorized_keys' -Value $MacKey -Encoding ascii
icacls 'C:\ProgramData\ssh\administrators_authorized_keys' /inheritance:r /grant '*S-1-5-32-544:F' '*S-1-5-18:F' | Out-Null

Write-Host "=== Restricting sshd ===" -ForegroundColor Cyan
# Key-only access. The directive has to sit ABOVE the first Match block, or it
# applies to no one at all.
if (Test-Path $SshdConfig) {
    $clean = @(Get-Content $SshdConfig | Where-Object { $_ -notmatch '^\s*#?\s*PasswordAuthentication\s' })
    $insertAt = $clean.Count
    for ($i = 0; $i -lt $clean.Count; $i++) {
        if ($clean[$i] -match '^\s*Match\s') { $insertAt = $i; break }
    }
    if ($insertAt -lt 1) { $insertAt = [Math]::Min(1, $clean.Count) }
    $head = if ($insertAt -gt 0) { $clean[0..($insertAt - 1)] } else { @() }
    $tail = if ($insertAt -lt $clean.Count) { $clean[$insertAt..($clean.Count - 1)] } else { @() }
    $new = @($head) + @('# AMA: key-only access', 'PasswordAuthentication no') + @($tail)
    [System.IO.File]::WriteAllLines($SshdConfig, $new)
    Write-Host "  PasswordAuthentication no written above the first Match block"
} else {
    Write-Host "  sshd_config not found - password authentication left as it was" -ForegroundColor Yellow
}

# sshd reads its config once at startup, so the change above only takes effect
# after a restart. Restarting inline would drop the SSH connection this script
# might be running over, so the restart is scheduled as a one-shot task.
$restartScript = Join-Path $env:TEMP 'ama-restart-sshd.ps1'
Set-Content -Path $restartScript -Value 'Restart-Service sshd -Force' -Encoding ascii
# schtasks takes a wall-clock HH:mm, so the time has to round up to a minute
# that is still in the future. Twenty seconds can round into the past.
$when = (Get-Date).AddSeconds(70).ToString('HH:mm')
schtasks /create /tn "AMA-Restart-SSHD" /sc once /st $when /tr "powershell.exe -NoProfile -ExecutionPolicy Bypass -File `"$restartScript`"" /f | Out-Null
Write-Host "  sshd restart scheduled at $when"

if (Get-Service sshd -ErrorAction SilentlyContinue) {
    Set-Service -Name sshd -StartupType Automatic
    Start-Service sshd

    $rule = Get-NetFirewallRule -Name 'AMA-OpenSSH-Server-In' -ErrorAction SilentlyContinue
    if ($rule) {
        # Re-scope an existing rule too: a rule left open to Any would keep
        # sshd reachable from every network the guest can see.
        $rule | Get-NetFirewallAddressFilter | Set-NetFirewallAddressFilter -RemoteAddress $TrustedSubnet
        Write-Host "  firewall rule present, remote scoped to $TrustedSubnet"
    } else {
        New-NetFirewallRule -Name 'AMA-OpenSSH-Server-In' `
            -DisplayName 'AMA OpenSSH Server (in)' `
            -Enabled True -Direction Inbound -Protocol TCP `
            -Action Allow -LocalPort 22 `
            -RemoteAddress $TrustedSubnet | Out-Null
        Write-Host "  firewall rule created (remote: $TrustedSubnet)"
    }
} else {
    Write-Host "  sshd service NOT AVAILABLE - OpenSSH install failed" -ForegroundColor Red
    exit 1
}

Write-Host "=== Waiting for sshd to listen ===" -ForegroundColor Cyan
$listening = $false
foreach ($i in 1..20) {
    if (Get-NetTCPConnection -LocalPort 22 -State Listen -ErrorAction SilentlyContinue) {
        $listening = $true
        break
    }
    Start-Sleep -Seconds 1
}

Write-Host "=== Status ===" -ForegroundColor Cyan
Get-Service sshd | Format-List Name, Status, StartType
if ($listening) {
    Write-Host "  sshd is listening on port 22" -ForegroundColor Green
} else {
    Write-Host "  ERROR: sshd is not listening on port 22" -ForegroundColor Red
}

Write-Host ""
$ip = (Get-NetIPAddress -AddressFamily IPv4 |
       Where-Object { $_.InterfaceAlias -notmatch 'Loopback' } |
       Select-Object -First 1).IPAddress
Write-Host "  From the Mac:"
Write-Host "    ssh -i ~/.ssh/ama_windows_ed25519 <windows-user>@$ip"
