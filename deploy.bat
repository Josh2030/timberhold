@echo off
REM ---------------------------------------------------------------
REM  Timberhold - publish the current index.html to the live site
REM  Run this from the project folder (double-click, or `deploy` in
REM  the VS Code terminal). Pass a message: deploy "what changed"
REM ---------------------------------------------------------------
setlocal
cd /d "%~dp0"

set "MSG=%~1"
if "%MSG%"=="" set "MSG=Update Timberhold"

echo.
echo === Staging changes ===
git add -A
git diff --cached --quiet && (
  echo Nothing new to commit - checking for unpushed commits...
) || (
  git commit -m "%MSG%" || goto :fail
)

echo.
echo === Pushing to GitHub ===
git push origin main || goto :fail

echo.
echo === Done ===
echo Live in about a minute at: https://josh2030.github.io/timberhold/
echo (Hard-refresh with Ctrl+F5 if you still see the old version.)

where firebase >nul 2>nul && (
  echo.
  echo Firebase CLI found - also deploying to timberhold-a6554.web.app
  call firebase deploy --only hosting
)

echo.
pause
exit /b 0

:fail
echo.
echo *** Deploy FAILED - see the error above. ***
echo.
echo   "could not read Username"  -^> run:  git push origin main
echo                                 and sign in when GitHub asks.
echo   "index.lock: File exists"  -^> a previous git run left a lock behind.
echo                                 Close any git/editor windows, then run:
echo                                 del .git\index.lock
pause
exit /b 1
