@echo off
setlocal DisableDelayedExpansion
set "ELECTRON_RUN_AS_NODE=1"
"%~dp0..\..\..\..\Ondra.exe" --expose-internals "%~dp0..\..\..\app.asar\ondra\node_modules\@ntars\ondra-desktop-host\lib\cli.js" %*
exit /b %errorlevel%
