@echo off
setlocal enabledelayedexpansion
chcp 65001 >nul 2>&1

:: ============================================================
::  SiamEPOS — New Restaurant Setup Script (Windows)
::  Run this on the customer's PC after installing the EXE.
::  Usage: Double-click this file, or run from Command Prompt.
:: ============================================================

title SiamEPOS Setup

echo.
echo ================================================
echo    SiamEPOS - New Restaurant Setup
echo ================================================
echo.
echo  This will configure SiamEPOS on this PC.
echo  You will need 3 values from Korakot before starting.
echo.
pause

:: ── Step 1 — Check SiamEPOS is installed ────────────────────
echo.
echo Step 1/5 - Checking requirements...

set "APP_PATH=%LOCALAPPDATA%\Programs\SiamEPOS\SiamEPOS.exe"
if exist "%APP_PATH%" (
  echo   [OK] SiamEPOS app found
) else (
  echo   [!!] SiamEPOS.exe not found at:
  echo        %APP_PATH%
  echo.
  echo   Please install SiamEPOS first using the Setup.exe,
  echo   then re-run this script.
  echo.
  set /p CONTINUE="   Continue anyway? (y/n): "
  if /i "!CONTINUE!" neq "y" (
    echo Setup cancelled.
    pause
    exit /b 1
  )
)

:: ── Step 2 — Collect restaurant details ─────────────────────
echo.
echo Step 2/5 - Restaurant details
echo   (Korakot will give you these values)
echo.

:ask_id
set /p RESTAURANT_ID="   Restaurant ID (e.g. baan-siam): "
if "!RESTAURANT_ID!"=="" (
  echo   [X] Restaurant ID cannot be empty.
  goto ask_id
)

:ask_name
set /p RESTAURANT_NAME="   Restaurant Name (e.g. Baan Siam): "
if "!RESTAURANT_NAME!"=="" (
  echo   [X] Restaurant name cannot be empty.
  goto ask_name
)

:: ── Step 3 — Cloud connection ────────────────────────────────
echo.
echo Step 3/5 - Cloud connection
echo.

:ask_url
set /p CLOUD_API_URL="   Cloud API URL (e.g. https://xxx.up.railway.app): "
if "!CLOUD_API_URL!"=="" (
  echo   [X] Cloud API URL cannot be empty.
  goto ask_url
)

:ask_secret
set /p SYNC_SECRET="   Sync Secret (long code from Korakot): "
if "!SYNC_SECRET!"=="" (
  echo   [X] Sync Secret cannot be empty.
  goto ask_secret
)

:: ── Step 4 — Write config.json ───────────────────────────────
echo.
echo Step 4/5 - Writing config...

set "CONFIG_DIR=%APPDATA%\siamepos-electron"
set "CONFIG_FILE=%CONFIG_DIR%\config.json"

if not exist "%CONFIG_DIR%" mkdir "%CONFIG_DIR%"

(
  echo {
  echo   "restaurant_name": "!RESTAURANT_NAME!",
  echo   "restaurant_id": "!RESTAURANT_ID!",
  echo   "cloud_api_url": "!CLOUD_API_URL!",
  echo   "sync_secret": "!SYNC_SECRET!"
  echo }
) > "%CONFIG_FILE%"

echo   [OK] Config saved to:
echo        %CONFIG_FILE%

:: ── Step 5 — Test connection ─────────────────────────────────
echo.
echo Step 5/5 - Testing connection...

:: Use PowerShell to test the URL (available on all modern Windows)
set "TEST_URL=!CLOUD_API_URL!/api/menu"
powershell -Command ^
  "try { $r = Invoke-WebRequest -Uri '!TEST_URL!' -UseBasicParsing -TimeoutSec 10; if ($r.StatusCode -eq 200) { Write-Host '  [OK] Connected to cloud successfully' } else { Write-Host ('  [!!] Server replied with status ' + $r.StatusCode) } } catch { Write-Host '  [X] Could not reach server - check URL and internet connection' }"

:: ── Done ─────────────────────────────────────────────────────
echo.
echo ================================================
echo   SiamEPOS is configured!
echo ================================================
echo.
echo   Launch SiamEPOS from your Desktop or Start Menu.
echo   On first open it will sync the full menu and staff list.
echo.
echo   Need help? Contact info@siamepos.co.uk
echo.
pause
