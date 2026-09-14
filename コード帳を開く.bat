@echo off
chcp 65001 >nul
rem 公開版のコード帳を、アドレス欄のないアプリの窓で開く（サーバーも Python も不要）
rem 曲は Dropbox 同期で iPhone と共有される。開発中の確認は .claude\devserver.py を使う
set "URL=https://ks-kit.github.io/chord-book/"
set "EDGE=%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe"
set "CHROME=%ProgramFiles%\Google\Chrome\Application\chrome.exe"
if exist "%EDGE%" (
  start "" "%EDGE%" --app=%URL%
) else if exist "%CHROME%" (
  start "" "%CHROME%" --app=%URL%
) else (
  start "" %URL%
)
exit
