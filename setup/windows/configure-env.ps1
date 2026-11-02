# Fix the PATH and environment the Windows toolchain needs, then verify it.
#
#   irm http://192.168.64.1:8099/configure-env.ps1 | iex
#
# Two things the installers leave behind:
#   1. Claude Code installs to %USERPROFILE%\.local\bin and does not add it to
#      PATH, so `claude` is only runnable by absolute path.
#   2. `python3` resolves to the Microsoft Store alias stub instead of the real
#      Python, so any script that calls `python3` fails.

$ErrorActionPreference = 'Continue'
$UserPath = [System.Environment]::GetEnvironmentVariable('Path', 'User')

function Prepend-ToUserPath([string]$Dir) {
    $current = [System.Environment]::GetEnvironmentVariable('Path', 'User')
    $parts = @($current -split ';' | Where-Object { $_ })
    if ($parts -contains $Dir) { return $false }
    [System.Environment]::SetEnvironmentVariable('Path', ((@($Dir) + $parts) -join ';'), 'User')
    return $true
}

$claudeBin = Join-Path $env:USERPROFILE '.local\bin'
if (Prepend-ToUserPath $claudeBin) { Write-Host "PATH += $claudeBin" }
else { Write-Host "PATH already contains $claudeBin" }

# A `python3` that reaches the real interpreter, not the Store alias.
$realPython = (Get-Command python -ErrorAction SilentlyContinue).Source
if ($realPython) {
    $shimDir = Join-Path $env:USERPROFILE 'bin'
    New-Item -ItemType Directory -Force -Path $shimDir | Out-Null
    $shim = Join-Path $shimDir 'python3.cmd'
    Set-Content -Path $shim -Value "@`"$realPython`" %*" -Encoding ascii
    if (Prepend-ToUserPath $shimDir) { Write-Host "PATH += $shimDir" }
    else { Write-Host "PATH already contains $shimDir" }
    Write-Host "python3 shim -> $realPython"
}

# Claude Code runs shell-form hooks through Git Bash. Pinning it stops it from
# resolving bash to some other interpreter that has no Git Bash semantics.
$gitBash = 'C:\Program Files\Git\bin\bash.exe'
if (Test-Path $gitBash) {
    [System.Environment]::SetEnvironmentVariable('CLAUDE_CODE_GIT_BASH_PATH', $gitBash, 'User')
    Write-Host "CLAUDE_CODE_GIT_BASH_PATH = $gitBash"
} else {
    Write-Host 'Git Bash not found at the expected path' -ForegroundColor Yellow
}

# Make this session see what was just persisted.
$env:Path = [System.Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' +
            [System.Environment]::GetEnvironmentVariable('Path', 'User')
$env:CLAUDE_CODE_GIT_BASH_PATH = [System.Environment]::GetEnvironmentVariable('CLAUDE_CODE_GIT_BASH_PATH', 'User')

Write-Host '=== verification ==='
foreach ($tool in 'git', 'node', 'npm', 'python', 'python3', 'claude') {
    $found = Get-Command $tool -ErrorAction SilentlyContinue
    if ($found) { Write-Host "FOUND $tool -> $($found.Source)" }
    else { Write-Host "MISSING $tool" }
}
Write-Host '=== versions ==='
git --version
node --version
python --version
python3 --version
claude --version
