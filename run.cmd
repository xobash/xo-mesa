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

call :check_long_paths

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
  call :refresh_paths
)

REM rustup installs cargo.exe as a proxy before a default toolchain necessarily
REM exists. `where cargo` therefore is not a readiness check: the proxy can be
REM present while every Cargo command fails with "no default is configured".
call cargo --version >nul 2>nul
if errorlevel 1 (
  where rustup >nul 2>nul
  if errorlevel 1 (
    echo   x Cargo is present but cannot run, and Rustup is unavailable to repair it.
    echo     Install Rust from https://rustup.rs, then re-run run.cmd.
    exit /b 1
  )
  echo   . Configuring the stable MSVC Rust toolchain...
  call rustup default stable-msvc
  if errorlevel 1 (
    echo   x Rustup could not install or select the stable MSVC toolchain.
    echo     Check the network error above, then re-run run.cmd.
    exit /b 1
  )
  call :refresh_paths
)

where cargo >nul 2>nul
if errorlevel 1 (
  echo   x Cargo still not found after Rust install.
  echo     Open a new terminal and re-run run.cmd. If it still fails, install Rust from https://rustup.rs.
  exit /b 1
)
call cargo --version >nul 2>nul
if errorlevel 1 (
  echo   x Cargo was found but the Rust toolchain is not usable.
  echo     Run "rustup default stable-msvc", then re-run run.cmd.
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

call :has_webview2
if not errorlevel 1 goto webview_ready
where winget >nul 2>nul
if errorlevel 1 (
  echo   x Microsoft Edge WebView2 Runtime not found and winget is unavailable.
  echo     Install Microsoft Edge WebView2 Runtime, then re-run run.cmd.
  exit /b 1
)
echo   . Ensuring WebView2 runtime is present...
call winget install --id Microsoft.EdgeWebView2Runtime -e --accept-source-agreements --accept-package-agreements
call :has_webview2
if errorlevel 1 (
  echo   x Microsoft Edge WebView2 Runtime still not found after install.
  echo     Restart the terminal after winget completes, then re-run run.cmd.
  exit /b 1
)
:webview_ready
echo   ok WebView2 runtime present

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

:check_long_paths
REM Windows refuses paths over 260 characters unless LongPathsEnabled is set.
REM Cargo and Tauri bury build artifacts deep under src-tauri\target - crate
REM out-dirs carry a 16-hex-digit hash and nest several levels - which adds
REM roughly 150 characters below this folder. So a project root past ~90
REM characters (a OneDrive-redirected Documents folder gets there on its own)
REM fails partway through the FIRST Rust build with an unhelpful "path too
REM long" or "file not found", long after setup appeared to succeed.
REM
REM Enabling long paths is a machine-wide, admin-only registry change, so this
REM only reports it and names both remedies. It never blocks the run: plenty of
REM installs are comfortably short, and a warning beats a false failure.
set "MESA_LONGPATHS="
for /f "tokens=3" %%A in ('reg query "HKLM\SYSTEM\CurrentControlSet\Control\FileSystem" /v LongPathsEnabled 2^>nul') do set "MESA_LONGPATHS=%%A"
if /i "%MESA_LONGPATHS%"=="0x1" exit /b 0
REM Non-empty only when the path is at least 91 characters long.
if "%CD:~90,1%"=="" exit /b 0
echo   ! Long paths are disabled and this folder's path is long:
echo       %CD%
echo     The Rust build writes files far below it and can fail with
echo     "path too long". Either move the project somewhere short like
echo     C:\dev\xo-mesa, or enable long paths once from an ADMIN terminal:
echo       reg add "HKLM\SYSTEM\CurrentControlSet\Control\FileSystem" /v LongPathsEnabled /t REG_DWORD /d 1 /f
echo     then sign out and back in.
exit /b 0

:refresh_paths
if exist "%SCOOP_SHIMS%" set "PATH=%SCOOP_SHIMS%;%PATH%"
if exist "%CARGO_BIN%" set "PATH=%CARGO_BIN%;%PATH%"
if exist "%NODE_BIN%" set "PATH=%NODE_BIN%;%PATH%"
if exist "%GIT_BIN%" set "PATH=%GIT_BIN%;%PATH%"
exit /b

:has_webview2
REM WebView2 is installed per-machine or per-user and is not normally on PATH.
REM Microsoft's documented registry signal covers a registered Evergreen runtime
REM even when its versioned install folder differs from these common paths.
for %%K in (
  "HKLM\SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}"
  "HKCU\SOFTWARE\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}"
  "HKLM\SOFTWARE\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}"
) do (
  REM `reg query` aligns columns with variable whitespace. Parsing the value
  REM directly avoids the fragile findstr pattern that missed valid pv values.
  for /f "tokens=1,2,*" %%A in ('reg query "%%~K" /v pv 2^>nul') do (
    if /i "%%A"=="pv" if not "%%C"=="" if /i not "%%C"=="0.0.0.0" exit /b 0
  )
)
REM Keep the executable checks as a fallback for runtimes without registration.
for /d %%D in ("%ProgramFiles(x86)%\Microsoft\EdgeWebView\Application\*") do if exist "%%~fD\msedgewebview2.exe" exit /b 0
for /d %%D in ("%ProgramFiles%\Microsoft\EdgeWebView\Application\*") do if exist "%%~fD\msedgewebview2.exe" exit /b 0
for /d %%D in ("%LOCALAPPDATA%\Microsoft\EdgeWebView\Application\*") do if exist "%%~fD\msedgewebview2.exe" exit /b 0
exit /b 1

:has_msvc_tools
where cl >nul 2>nul
if not errorlevel 1 exit /b 0
set "VSWHERE=%ProgramFiles(x86)%\Microsoft Visual Studio\Installer\vswhere.exe"
if not exist "%VSWHERE%" exit /b 1
set "MESA_VS_PATH="
for /f "delims=" %%V in ('"%VSWHERE%" -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -latest -property installationPath 2^>nul') do if not defined MESA_VS_PATH set "MESA_VS_PATH=%%V"
if not defined MESA_VS_PATH exit /b 1
if not exist "%MESA_VS_PATH%\Common7\Tools\VsDevCmd.bat" exit /b 1
call "%MESA_VS_PATH%\Common7\Tools\VsDevCmd.bat" -arch=x64 -host_arch=x64 >nul
where cl >nul 2>nul
if errorlevel 1 exit /b 1
where link >nul 2>nul
if errorlevel 1 exit /b 1
exit /b 0

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
