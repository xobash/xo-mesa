@echo off
REM Mesa - one-command setup & launch (Windows 10 / 11).
REM
REM Assumes NOTHING is installed. Brings a clean machine all the way to a running
REM Mesa desktop app, installing every missing dependency:
REM   * Node.js LTS, Rust, and Git      -> via Scoop (user-only, no admin)
REM   * Microsoft C++ Build Tools        -> via winget (raises its own UAC prompt)
REM   * WebView2 runtime                 -> via winget (already on Win11/most Win10)
REM   * JS deps                          -> .\node_modules (local to this project)
REM Then launches the desktop app.
REM
REM Run from this folder in a NORMAL (non-admin) PowerShell/cmd window:  run.cmd
setlocal enabledelayedexpansion
cd /d "%~dp0"
set "SCOOP_SHIMS=%USERPROFILE%\scoop\shims"
set "CARGO_BIN=%USERPROFILE%\.cargo\bin"
set "NODE_BIN=%ProgramFiles%\nodejs"
set "GIT_BIN=%ProgramFiles%\Git\cmd"
call :refresh_paths

echo ^> Mesa - setup ^& launch

REM --- Node.js (+ Scoop bootstrap if we need to install anything) -------------
where npm >nul 2>nul
if errorlevel 1 (
  call :ensure_scoop
  if not errorlevel 1 (
    echo   . Installing Node.js LTS via Scoop...
    call scoop install nodejs-lts
    call :refresh_paths
  )
  where npm >nul 2>nul
  if errorlevel 1 (
    echo   . Installing Node.js LTS via winget...
    call :install_winget OpenJS.NodeJS.LTS "Node.js LTS"
    call :refresh_paths
  )
)
where npm >nul 2>nul
if errorlevel 1 (
  echo   x Node.js still not found after install.
  echo     Install Node.js LTS, or open a new terminal if winget just installed it, then re-run run.cmd.
  exit /b 1
)
echo   ok Node.js present

REM --- Git (Scoop) ------------------------------------------------------------
where git >nul 2>nul
if errorlevel 1 (
  call :ensure_scoop
  if not errorlevel 1 (
    echo   . Installing Git via Scoop...
    call scoop install git
    call :refresh_paths
  )
  where git >nul 2>nul
  if errorlevel 1 (
    echo   . Installing Git via winget...
    call :install_winget Git.Git "Git"
    call :refresh_paths
  )
)
where git >nul 2>nul
if errorlevel 1 (
  echo   x Git still not found after install. Open a new terminal and re-run run.cmd.
  exit /b 1
)

REM --- Rust (rustup, MSVC toolchain) ------------------------------------------
where cargo >nul 2>nul
if errorlevel 1 (
  call :ensure_scoop
  if not errorlevel 1 (
    echo   . Installing Rust via Scoop rustup...
    call scoop install rustup
    call :refresh_paths
  )
  where rustup >nul 2>nul
  if errorlevel 1 (
    echo   . Installing Rust via winget rustup...
    call :install_winget Rustlang.Rustup "Rust rustup"
    call :refresh_paths
  )
  where rustup >nul 2>nul
  if errorlevel 1 (
    echo   x Rustup still not found after install.
    echo     Install Rust from https://rustup.rs or open a new terminal if winget just installed it, then re-run run.cmd.
    exit /b 1
  )
  call rustup default stable-msvc
  if errorlevel 1 exit /b 1
  call :refresh_paths
)
where cargo >nul 2>nul
if errorlevel 1 (
  echo   x Cargo still not found after Rust install.
  echo     Open a new terminal and re-run run.cmd. If it still fails, install Rust from https://rustup.rs.
  exit /b 1
)
echo   ok Rust/Cargo present

REM --- Microsoft C++ Build Tools + WebView2 (winget) --------------------------
REM Rust needs the MSVC linker (cl.exe/link.exe) from the VC++ Build Tools.
call :has_msvc_tools
if errorlevel 1 (
  where winget >nul 2>nul
  if errorlevel 1 (
    echo   x Microsoft C++ Build Tools not found and winget is unavailable.
    echo     Install "App Installer" from the Microsoft Store,
    echo     or grab "Build Tools for Visual Studio" and tick
    echo     "Desktop development with C++", then re-run run.cmd.
    exit /b 1
  ) else (
    echo   . Installing Microsoft C++ Build Tools via winget ^(UAC prompt^)...
    winget install --id Microsoft.VisualStudio.2022.BuildTools -e --accept-source-agreements --accept-package-agreements --override "--quiet --wait --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended"
  )
)
call :has_msvc_tools
if errorlevel 1 (
  echo   x Microsoft C++ Build Tools still not found after install.
  echo     Open a new terminal and re-run run.cmd. If it still fails, install
  echo     "Build Tools for Visual Studio" with "Desktop development with C++".
  exit /b 1
)
echo   ok Microsoft C++ Build Tools present

where winget >nul 2>nul
if not errorlevel 1 (
  echo   . Ensuring WebView2 runtime is present...
  winget install --id Microsoft.EdgeWebView2Runtime -e --accept-source-agreements --accept-package-agreements
) else (
  echo   ! winget not found; skipping automatic WebView2 check.
  echo     If Mesa opens blank, install Microsoft Edge WebView2 Runtime and re-run run.cmd.
)

echo   . Installing JS dependencies...
call npm install
if errorlevel 1 exit /b 1

REM Guard against a stale Rust build cache. Cargo and Tauri bake this folder's
REM absolute path into src-tauri\target (and the generated files in src-tauri\gen).
REM If the project was moved or renamed since the last build those paths are wrong
REM and the build fails. Stamp the build path; if it no longer matches, clear the
REM cache once so it recompiles cleanly.
set "STAMP=src-tauri\.build-cache-path"
if exist "src-tauri\target" if exist "%STAMP%" call :checkmoved
>"%STAMP%" echo %CD%

echo ^> Launching Mesa - the FIRST run compiles Rust, give it a few minutes.
call npm run mesa
endlocal
goto :eof

:checkmoved
set "LASTPATH="
set /p LASTPATH=<"%STAMP%"
if not "%LASTPATH%"=="%CD%" (
  echo   . Project folder moved since last build - clearing stale Rust cache...
  rmdir /s /q "src-tauri\target"
  if exist "src-tauri\gen" rmdir /s /q "src-tauri\gen"
)
exit /b

:refresh_paths
if exist "%SCOOP_SHIMS%" set "PATH=%SCOOP_SHIMS%;%PATH%"
if exist "%CARGO_BIN%" set "PATH=%CARGO_BIN%;%PATH%"
if exist "%NODE_BIN%" set "PATH=%NODE_BIN%;%PATH%"
if exist "%GIT_BIN%" set "PATH=%GIT_BIN%;%PATH%"
exit /b

:has_msvc_tools
where cl >nul 2>nul
if not errorlevel 1 exit /b 0
set "VSWHERE=%ProgramFiles(x86)%\Microsoft Visual Studio\Installer\vswhere.exe"
if exist "%VSWHERE%" (
  for /f "delims=" %%V in ('"%VSWHERE%" -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -latest -property installationPath 2^>nul') do exit /b 0
)
exit /b 1

:ensure_scoop
where scoop >nul 2>nul
if not errorlevel 1 exit /b 0
echo   . Installing Scoop package manager ^(user-only^)...
powershell -NoProfile -ExecutionPolicy Bypass -Command "irm get.scoop.sh | iex"
set "PATH=%SCOOP_SHIMS%;%PATH%"
where scoop >nul 2>nul
if errorlevel 1 (
  echo   ! Scoop install did not complete; falling back where possible.
  exit /b 1
)
exit /b 0

:install_winget
where winget >nul 2>nul
if errorlevel 1 (
  echo   ! winget not found; cannot install %~2 automatically.
  exit /b 1
)
winget install --id %~1 -e --accept-source-agreements --accept-package-agreements
exit /b %errorlevel%
