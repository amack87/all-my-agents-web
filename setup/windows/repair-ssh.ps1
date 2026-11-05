# Repair SSH access on a Windows AMA host.
#
# Use this when the Mac can no longer log in over SSH but the VM is still
# running — for example after authorized_keys was overwritten with a broken
# key. It fetches the Mac's public key over HTTP, writes it to both places
# Windows OpenSSH reads, and restarts sshd.
#
# Run in an ELEVATED PowerShell window ON THE VM:
#
#   iwr http://192.168.64.1:8099/repair-ssh.ps1 -OutFile $env:TEMP\repair-ssh.ps1
#   powershell -NoProfile -ExecutionPolicy Bypass -File $env:TEMP\repair-ssh.ps1
#
# The key URL defaults to the Mac's HTTP server on the virtualization bridge.
# Override it with -KeyUrl, or pass the key itself with -MacPublicKey.

param(
    [string]$MacPublicKey = '',
    [string]$KeyUrl = 'http://192.168.64.1:8099/ama_windows_ed25519.pub',
    # Skip the sshd restart. sshd re-reads authorized_keys on every
    # authentication attempt, so the key fix alone restores access; the restart
    # is only so a freshly written sshd_config takes effect.
    [switch]$NoRestart,
    # Refuse to write the key unless it hashes to this fingerprint. The key is
    # fetched over plain HTTP from the bridge, so anything local could squat
    # that port and serve a key of its own — which the VM would then trust.
    # Pass the Mac's own fingerprint to close that hole:
    #   ssh-keygen -lf ~/.ssh/ama_windows_ed25519.pub | awk '{print $2}'
    # which prints SHA256:<base64>.
    [string]$ExpectedFingerprint = ''
)

$ErrorActionPreference = 'Stop'

if (-not $MacPublicKey) {
    Write-Host "=== Fetching the Mac public key ===" -ForegroundColor Cyan
    Write-Host "  from $KeyUrl"
    # Invoke-WebRequest hands back a byte[] whenever the server does not label
    # the response as text (python's http.server serves .pub as
    # application/x-mspublisher), so decode before trimming.
    $response = Invoke-WebRequest -UseBasicParsing -Uri $KeyUrl
    $content = $response.Content
    if ($content -is [byte[]]) { $content = [System.Text.Encoding]::UTF8.GetString($content) }
    $MacPublicKey = ([string]$content).Trim()
    if ($MacPublicKey -notmatch '^ssh-ed25519\s+\S+' -and $KeyUrl -match '\.pub$') {
        # The same key served with a .txt extension comes back as text.
        $fallback = $KeyUrl -replace '\.pub$', '.txt'
        Write-Host "  retrying $fallback"
        $response = Invoke-WebRequest -UseBasicParsing -Uri $fallback
        $content = $response.Content
        if ($content -is [byte[]]) { $content = [System.Text.Encoding]::UTF8.GetString($content) }
        $MacPublicKey = ([string]$content).Trim()
    }
}
if (-not $MacPublicKey -or $MacPublicKey -notmatch '^ssh-ed25519\s+\S+') {
    Write-Host "  ERROR: no usable public key (expected an 'ssh-ed25519 <base64>' line)" -ForegroundColor Red
    exit 2
}
$fingerprint = ''
try {
    # SHA256::HashData is .NET 5+ only; Windows PowerShell 5.1 is .NET
    # Framework. Use the older Create()/ComputeHash() pair, and never let the
    # fingerprint be fatal.
    $sha = [System.Security.Cryptography.SHA256]::Create()
    try {
        $hash = $sha.ComputeHash([System.Text.Encoding]::UTF8.GetBytes($MacPublicKey))
        $fingerprint = ([System.BitConverter]::ToString($hash)).Replace('-', '').ToLower()
    } finally {
        $sha.Dispose()
    }
    Write-Host "  key fingerprint: SHA256:$fingerprint"
} catch {
    Write-Host "  (fingerprint unavailable: $($_.Exception.Message))" -ForegroundColor Yellow
}

if ($ExpectedFingerprint) {
    # Compare only the hex, so "SHA256:ab:cd" and "abcd" both work.
    $expected = ($ExpectedFingerprint -replace '^SHA256:', '' -replace '[^0-9a-fA-F]', '').ToLower()
    $actual = ($fingerprint -replace '[^0-9a-fA-F]', '').ToLower()
    if (-not $actual) {
        Write-Host "  ERROR: could not hash the key, so it cannot be verified" -ForegroundColor Red
        Write-Host "         refusing to write an unverified key" -ForegroundColor Red
        exit 3
    }
    if ($expected -ne $actual) {
        Write-Host "  ERROR: the key does not match the expected fingerprint" -ForegroundColor Red
        Write-Host "         expected SHA256:$expected" -ForegroundColor Red
        Write-Host "         actual   SHA256:$actual" -ForegroundColor Red
        Write-Host "         refusing to write it" -ForegroundColor Red
        exit 3
    }
    Write-Host "  fingerprint matches the expected value" -ForegroundColor Green
}

Write-Host "=== Writing authorized_keys ===" -ForegroundColor Cyan
# Windows OpenSSH reads ~/.ssh/authorized_keys for normal accounts, but routes
# members of the Administrators group to
# C:\ProgramData\ssh\administrators_authorized_keys instead. Write both.
$targets = @(
    (Join-Path $env:USERPROFILE '.ssh\authorized_keys'),
    'C:\ProgramData\ssh\administrators_authorized_keys'
)
foreach ($target in $targets) {
    $parent = Split-Path $target -Parent
    if (-not (Test-Path $parent)) { New-Item -ItemType Directory -Force -Path $parent | Out-Null }
    Set-Content -Path $target -Value $MacPublicKey -Encoding ascii
    # sshd refuses a key file that anyone but Administrators and SYSTEM can write.
    icacls $target /inheritance:r /grant '*S-1-5-32-544:F' '*S-1-5-18:F' | Out-Null
    Write-Host "  wrote $target"
}

Write-Host "=== Restarting sshd ===" -ForegroundColor Cyan
# sshd re-reads authorized_keys on every authentication attempt, so the key fix
# above already works without a restart. The restart is only so a freshly
# written sshd_config takes effect. Back the config up first: if the restart
# leaves sshd not listening, the config is what broke it, and we put it back.
$SshdConfig = 'C:\ProgramData\ssh\sshd_config'
$configBackup = ''
if (Test-Path $SshdConfig) {
    $configBackup = Join-Path $env:TEMP 'ama-sshd_config.backup'
    Copy-Item $SshdConfig $configBackup -Force
    Write-Host "  sshd_config backed up to $configBackup"
}

function Test-SshdListening {
    foreach ($i in 1..20) {
        if (Get-NetTCPConnection -LocalPort 22 -State Listen -ErrorAction SilentlyContinue) { return $true }
        Start-Sleep -Seconds 1
    }
    return $false
}

if ($NoRestart) {
    Write-Host "  -NoRestart given: leaving the running sshd alone" -ForegroundColor Yellow
    $listening = Test-SshdListening
} else {
    try {
        Restart-Service sshd -Force
        Write-Host "  sshd restarted" -ForegroundColor Green
    } catch {
        Write-Host "  could not restart sshd: $($_.Exception.Message)" -ForegroundColor Yellow
    }

    $listening = Test-SshdListening
    if (-not $listening -and $configBackup -and (Test-Path $configBackup)) {
        Write-Host "  sshd is not listening - restoring the backed-up sshd_config" -ForegroundColor Yellow
        Copy-Item $configBackup $SshdConfig -Force
        try {
            Restart-Service sshd -Force
            Write-Host "  sshd restarted with the restored config" -ForegroundColor Yellow
        } catch {
            Write-Host "  still could not restart sshd: $($_.Exception.Message)" -ForegroundColor Red
        }
        $listening = Test-SshdListening
    }
}

Write-Host ""
if ($listening) {
    Write-Host "=== AMA_SSH_FIXED ===" -ForegroundColor Green
} else {
    Write-Host "=== AMA_SSH_NOT_LISTENING ===" -ForegroundColor Red
}
