# Install the toolchain AMA needs to develop and test Claude Code plugins on
# Windows. Run it in an elevated PowerShell on the target machine:
#
#   irm http://192.168.64.1:8099/install-toolchain.ps1 | iex
#
# Everything is installed with winget so it lands in the standard install
# locations and the standard PATH, the same way an engineer's machine is set
# up. Progress is written to %TEMP%\ama-toolchain.log so a dropped
# connection does not lose the trail.

$ErrorActionPreference = 'Continue'
$LogPath = Join-Path $env:TEMP 'ama-toolchain.log'

function Step([string]$Message) {
    $line = "[{0}] {1}" -f (Get-Date -Format 'HH:mm:ss'), $Message
    Write-Host $line
    Add-Content -Path $LogPath -Value $line
}

function Install([string]$Label, [string]$Id) {
    Step "installing $Label ($Id)"
    & winget install --id $Id -e --source winget `
        --accept-package-agreements --accept-source-agreements `
        --disable-interactivity | Out-Null
    $code = $LASTEXITCODE
    # 0 = installed, 3010 = installed but a reboot is wanted, -1978335189 =
    # an acceptable version is already present.
    $ok = ($code -eq 0) -or ($code -eq 3010) -or ($code -eq -1978335189)
    Step "$Label finished (winget exit $code, accepted=$ok)"
}

Step '=== toolchain install starting ==='

Install 'Git for Windows' 'Git.Git'
Install 'Node.js LTS' 'OpenJS.NodeJS.LTS'
Install 'Python 3.12' 'Python.Python.3.12'

Step 'installing Claude Code'
try {
    Invoke-RestMethod -Uri 'https://claude.ai/install.ps1' | Invoke-Expression
    Step 'Claude Code installer finished'
} catch {
    Step "Claude Code install failed: $($_.Exception.Message)"
}

# The installs above are not visible in this session's PATH until it is
# rebuilt from the registry, so rebuild it before verifying.
$env:Path = [System.Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' +
            [System.Environment]::GetEnvironmentVariable('Path', 'User')

Step '=== verification ==='
foreach ($tool in 'git', 'node', 'npm', 'python', 'python3', 'claude') {
    $found = Get-Command $tool -ErrorAction SilentlyContinue
    if ($found) {
        Step "FOUND $tool -> $($found.Source)"
    } else {
        Step "MISSING $tool"
    }
}

Step '=== toolchain install done ==='
