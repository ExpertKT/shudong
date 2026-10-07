@echo off
rem Shudong one-click launcher: start each server only when nobody is listening, then open the browser.
rem (Keep this file ASCII-only: cmd.exe reads .cmd in the OEM codepage, so non-ASCII here breaks parsing.)
rem Pass-through args so "start-shudong.cmd -Install" / "-Uninstall" also work.
set PS=pwsh
where pwsh >nul 2>nul || set PS=powershell
%PS% -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "%~dp0start-shudong.ps1" %*
