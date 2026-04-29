# LUBA tracker - daily run
# Runs: snapshot, check alerts, commit changed data, push.
# Idempotent: if data did not change, no commit.

$ErrorActionPreference = 'Continue'
# git writes warnings to stderr which trips Stop mode; we check $LASTEXITCODE manually instead.
$global:didError = $false
$repo = Split-Path -Parent $PSScriptRoot
Set-Location $repo

$logFile = Join-Path $PSScriptRoot 'last-run.log'
"=== run at $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss zzz') ===" | Out-File -FilePath $logFile -Encoding utf8

try {
    "[1] running snapshot..." | Out-File -FilePath $logFile -Append
    & node "$PSScriptRoot/snapshot.mjs" 2>&1 | Out-File -FilePath $logFile -Append

    "[2] checking alerts..." | Out-File -FilePath $logFile -Append
    & node "$PSScriptRoot/check-alerts.mjs" 2>&1 | Out-File -FilePath $logFile -Append

    "[3] git status..." | Out-File -FilePath $logFile -Append
    $status = git status --porcelain data 2>&1
    if (-not $status) {
        "  no data changes - skipping commit" | Out-File -FilePath $logFile -Append
        exit 0
    }

    "[4] committing and pushing..." | Out-File -FilePath $logFile -Append
    git add data 2>&1 | Out-File -FilePath $logFile -Append
    if ($LASTEXITCODE -ne 0) { throw 'git add failed' }
    $stamp = Get-Date -Format 'yyyy-MM-dd HH:mm'
    git -c user.email='watson@tropac.com.au' -c user.name='Watson (cron)' commit -m "snapshot: $stamp AEST" 2>&1 | Out-File -FilePath $logFile -Append
    if ($LASTEXITCODE -ne 0) { throw 'git commit failed' }
    git push 2>&1 | Out-File -FilePath $logFile -Append
    if ($LASTEXITCODE -ne 0) { throw 'git push failed' }

    "[done]" | Out-File -FilePath $logFile -Append
} catch {
    "[ERROR] $_" | Out-File -FilePath $logFile -Append
    exit 1
}
