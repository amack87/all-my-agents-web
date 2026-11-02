# Enable OpenSSH on the Windows host and trust the Mac's key.
#
# Gives the Mac a control channel into the VM so the rest of the setup can be
# driven remotely. Run in an ELEVATED PowerShell window:
#
#   powershell -ExecutionPolicy Bypass -File enable-ssh.ps1
#
# Prints the SSH command to run from the Mac.

$ErrorActionPreference = 'Continue'

$MacKey = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIK66wqy53C3QrFbzUH7mA4Zo9EM47Wot7iDtOs5gu7E1 ama-mac-to-windows-vm'

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

Write-Host "=== Configuring sshd ===" -ForegroundColor Cyan
if (Get-Service sshd -ErrorAction SilentlyContinue) {
    Set-Service -Name sshd -StartupType Automatic
    Start-Service sshd

    if (-not (Get-NetFirewallRule -Name 'AMA-OpenSSH-Server-In' -ErrorAction SilentlyContinue)) {
        New-NetFirewallRule -Name 'AMA-OpenSSH-Server-In' `
            -DisplayName 'AMA OpenSSH Server (in)' `
            -Enabled True -Direction Inbound -Protocol TCP `
            -Action Allow -LocalPort 22 | Out-Null
        Write-Host "  firewall rule created"
    } else {
        Write-Host "  firewall rule already present"
    }
} else {
    Write-Host "  sshd service NOT AVAILABLE - OpenSSH install failed" -ForegroundColor Red
    exit 1
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

$ip = (Get-NetIPAddress -AddressFamily IPv4 |
       Where-Object { $_.InterfaceAlias -notmatch 'Loopback' } |
       Select-Object -First 1).IPAddress
Write-Host ""
Write-Host "  From the Mac:"
Write-Host "    ssh -i ~/.ssh/ama_windows_ed25519 <windows-user>@$ip"
