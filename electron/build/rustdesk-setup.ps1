# SiamEPOS — SEPOS-REMOTE-002: remote support built into the till (Windows).
# Run ELEVATED by electron/main.js on launch. Idempotent and non-fatal:
#   1. install RustDesk silently if it is not installed
#   2. point it at OUR server (id/relay + public key, direct-IP on)
#   3. set a permanent password once, read the ID, write both to
#      %ProgramData%\SiamEPOS\remote.json (the app reads that file and reports
#      ID + password to the restaurant's own tenant with the sync secret)
# Any failure just exits 0 — the till must never be blocked by this.
$ErrorActionPreference = 'Continue'
$ProgressPreference = 'SilentlyContinue'
$srv = '134.209.180.63'
$key = 'YCXPVAxyj9aFnKcb5+4kUKjVghUghvox4O6mCAk7cSU='
$ver = '1.4.9'
$dataDir = Join-Path $env:ProgramData 'SiamEPOS'
$stateFile = Join-Path $dataDir 'remote.json'
$rd = Join-Path $env:ProgramFiles 'RustDesk\rustdesk.exe'
try {
  New-Item -ItemType Directory -Force -Path $dataDir | Out-Null
  if (Test-Path $stateFile) {
    $st = Get-Content $stateFile -Raw | ConvertFrom-Json
    if ($st.id -and $st.password -and (Test-Path $rd)) { exit 0 }   # already done
  }
  if (-not (Test-Path $rd)) {
    $exe = Join-Path $env:TEMP 'rustdesk-setup.exe'
    Invoke-WebRequest -Uri "https://github.com/rustdesk/rustdesk/releases/download/$ver/rustdesk-$ver-x86_64.exe" -OutFile $exe -TimeoutSec 120
    Unblock-File $exe
    Start-Process $exe -ArgumentList '--silent-install' -Wait
    Start-Sleep 8
  }
  if (-not (Test-Path $rd)) { exit 0 }
  $cfg = @"
rendezvous_server = '${srv}:21116'
nat_type = 1
serial = 0

[options]
custom-rendezvous-server = '$srv'
relay-server = '$srv'
api-server = ''
key = '$key'
direct-server = 'Y'
"@
  foreach ($d in @((Join-Path $env:APPDATA 'RustDesk\config'), 'C:\Windows\ServiceProfiles\LocalService\AppData\Roaming\RustDesk\config')) {
    New-Item -ItemType Directory -Force -Path $d | Out-Null
    Set-Content -Path (Join-Path $d 'RustDesk2.toml') -Value $cfg -Encoding Ascii
  }
  Restart-Service RustDesk -ErrorAction SilentlyContinue
  Start-Sleep 6
  $pw = -join ((48..57 + 65..90 + 97..122) | Get-Random -Count 12 | ForEach-Object { [char]$_ })
  & $rd --password $pw | Out-Null
  Start-Sleep 2
  $id = (& $rd --get-id | Out-String).Trim()
  if ($id -match '^\d{6,12}$') {
    @{ id = $id; password = $pw; server = $srv; set_at = (Get-Date).ToString('o') } | ConvertTo-Json | Set-Content -Path $stateFile -Encoding Ascii
  }
} catch { }
exit 0
