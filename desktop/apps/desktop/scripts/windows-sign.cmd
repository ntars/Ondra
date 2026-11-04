@echo off
setlocal DisableDelayedExpansion
set "signTool=%ONDRA_DESKTOP_WINDOWS_SIGNTOOL%"
set "certificateFile=%ONDRA_DESKTOP_WINDOWS_CER_FILE%"
set "tokenPin=%ONDRA_DESKTOP_WINDOWS_TOKEN_PIN%"
set "keyContainer=%ONDRA_DESKTOP_WINDOWS_KEY_CONTAINER%"
set "targetFile=%ONDRA_DESKTOP_WINDOWS_SIGN_TARGET%"
set "appendSignature="
if "%ONDRA_DESKTOP_WINDOWS_SIGN_APPEND%"=="1" set "appendSignature=/as"
set "ONDRA_DESKTOP_WINDOWS_SIGNTOOL="
set "ONDRA_DESKTOP_WINDOWS_CER_FILE="
set "ONDRA_DESKTOP_WINDOWS_TOKEN_PIN="
set "ONDRA_DESKTOP_WINDOWS_KEY_CONTAINER="
set "ONDRA_DESKTOP_WINDOWS_SIGN_TARGET="
set "ONDRA_DESKTOP_WINDOWS_SIGN_APPEND="
set "signTool=" & set "certificateFile=" & set "tokenPin=" & set "keyContainer=" & set "targetFile=" & set "appendSignature=" & "%signTool%" sign /v /fd sha256 /f "%certificateFile%" /kc "[{{%tokenPin%}}]=%keyContainer%" /csp "eToken Base Cryptographic Provider" %appendSignature% "%targetFile%"
exit /b %errorlevel%
