# Read-only environment diagnostic for the All My Agents Windows host.
#
# Purpose: determine whether WSL2 can run inside this VM, and whether we can
# reach it from the Mac. Run in an ELEVATED PowerShell window:
#
#   powershell -ExecutionPolicy Bypass -File diagnose.ps1
#
# This script changes nothing. Paste the full output back to the operator.

$ErrorActionPreference = 'Continue'
$ProgressPreference = 'SilentlyContinue'

function Section($title) {
    Write-Host ""
    Write-Host "=== $title ===" -ForegroundColor Cyan
}

Section "Windows"
$os = Get-CimInstance Win32_OperatingSystem
$cs = Get-CimInstance Win32_ComputerSystem
$cpu = Get-CimInstance Win32_Processor | Select-Object -First 1
"OS                 : $($os.Caption) $($os.Version) (build $($os.BuildNumber))"
"Architecture       : $($os.OSArchitecture)"
"System type        : $($cs.SystemType)"
"Model              : $($cs.Model)"
"HypervisorPresent  : $($cs.HypervisorPresent)"
"Free RAM (GB)      : {0:N1}" -f ($cs.TotalPhysicalMemory / 1GB)
"Free disk C: (GB)  : {0:N1}" -f ((Get-PSDrive C).Free / 1GB)

Section "Nested virtualization (needed for WSL2)"
"VirtualizationFirmwareEnabled : $($cpu.VirtualizationFirmwareEnabled)"
"SecondLevelAddressTranslation  : $($cpu.SecondLevelAddressTranslationExtensionsEnabled)"
foreach ($feat in 'Microsoft-Hyper-V-All', 'VirtualMachinePlatform', 'Microsoft-Windows-Subsystem-Linux', 'HypervisorPlatform') {
    try {
        $state = (Get-WindowsOptionalFeature -Online -FeatureName $feat -ErrorAction Stop).State
    } catch {
        $state = "NOT AVAILABLE"
    }
    "{0,-38}: {1}" -f $feat, $state
}

Section "WSL"
if (Get-Command wsl.exe -ErrorAction SilentlyContinue) {
    "wsl --version:"
    wsl --version 2>&1 | ForEach-Object { "  $_" }
    "wsl --status:"
    wsl --status 2>&1 | ForEach-Object { "  $_" }
    "wsl -l -v:"
    wsl -l -v 2>&1 | ForEach-Object { "  $_" }
} else {
    "wsl.exe NOT PRESENT - WSL is not installed at all"
}

Section "WSL2 functional test"
"probe: wsl -d Ubuntu-24.04 -- echo WSL2_OK"
$probe = wsl -d Ubuntu-24.04 -- echo WSL2_OK 2>&1 | Out-String
"  result: $($probe.Trim())"
if ($probe -match 'WSL2_OK') {
    "  VERDICT: WSL2 BOOTS"
    "arch: " + ((wsl -d Ubuntu-24.04 -- uname -m 2>&1 | Out-String).Trim())
} else {
    "  VERDICT: WSL2 DID NOT BOOT (see error above)"
    "  If this mentions 'virtual machine platform' or a nested-hypervisor error,"
    "  WSL2 cannot run inside this VM and the plan must change."
}

Section "Networking (IPv4, non-loopback)"
Get-NetIPAddress -AddressFamily IPv4 |
    Where-Object { $_.IPAddress -notlike '127.*' -and $_.IPAddress -notlike '169.254.*' } |
    Select-Object InterfaceAlias, IPAddress, PrefixLength |
    Format-Table -AutoSize | Out-String | ForEach-Object { $_.TrimEnd() }

Section "Tailscale"
if (Get-Command tailscale.exe -ErrorAction SilentlyContinue) {
    tailscale version 2>&1 | ForEach-Object { "  $_" }
} else {
    "  tailscale NOT INSTALLED"
}

Section "OpenSSH server"
try {
    $svc = Get-Service sshd -ErrorAction Stop
    "  sshd service: $($svc.Status)"
} catch {
    "  sshd NOT INSTALLED (run enable-ssh.ps1)"
}

Section "Internet reachability"
foreach ($u in 'https://github.com', 'https://pkgs.tailscale.com') {
    try {
        $code = (Invoke-WebRequest -Uri $u -UseBasicParsing -TimeoutSec 15).StatusCode
        "  $u -> $code"
    } catch {
        "  $u -> FAILED: $($_.Exception.Message)"
    }
}

Section "Done"
"Report the full output of this script to the operator."
