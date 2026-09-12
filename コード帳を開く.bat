@echo off
chcp 65001 >nul
cd /d "%~dp0"
start "" /min cmd /c "python .claude\devserver.py 8766"
timeout /t 2 >nul
start "" http://localhost:8766/
exit
