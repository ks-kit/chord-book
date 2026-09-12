@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo 下に出るアドレスを iPhone の Safari で開いてください。
echo この窓を閉じると止まります。
echo.
python .claude\devserver.py 8766 --lan
pause
