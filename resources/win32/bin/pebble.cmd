@echo off
setlocal
set "SCRIPT_DIR=%~dp0"
for %%I in ("%SCRIPT_DIR%..") do set "RESOURCES_DIR=%%~fI"
REM Why: once %%~fI canonicalizes RESOURCES_DIR it no longer ends with a slash,
REM so Windows batch needs an explicit "\.." segment here. Without it the CLI
REM launcher resolves APP_DIR back to resources/ and `pebble open` cannot find
REM Pebble.exe on packaged Windows installs.
for %%I in ("%RESOURCES_DIR%\..") do set "APP_DIR=%%~fI"
set "ELECTRON=%APP_DIR%\Pebble.exe"
if not exist "%ELECTRON%" set "ELECTRON=%APP_DIR%\Pebble.exe"

if not exist "%ELECTRON%" (
  echo Unable to locate Pebble.exe next to "%RESOURCES_DIR%" 1>&2
  exit /b 1
)

REM Why: Pebble packages the CLI entrypoint outside app.asar so the public shell
REM command can execute it directly with ELECTRON_RUN_AS_NODE instead of
REM depending on a separately installed Node CLI.
set "CLI=%RESOURCES_DIR%\app.asar.unpacked\out\cli\index.js"

set "PEBBLE_NODE_OPTIONS=%NODE_OPTIONS%"
set "PEBBLE_NODE_REPL_EXTERNAL_MODULE=%NODE_REPL_EXTERNAL_MODULE%"
REM Why: older installed shims and startup redirect code still read PEBBLE_* while
REM users migrate; keep both protocol names carrying the same values.
set "PEBBLE_NODE_OPTIONS=%NODE_OPTIONS%"
set "PEBBLE_NODE_REPL_EXTERNAL_MODULE=%NODE_REPL_EXTERNAL_MODULE%"
set NODE_OPTIONS=
set NODE_REPL_EXTERNAL_MODULE=
set ELECTRON_RUN_AS_NODE=1

"%ELECTRON%" "%CLI%" %*
