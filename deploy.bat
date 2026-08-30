@echo off
REM ---------------------------------------------------------------
REM  Timberhold - publish the current index.html to the live sites.
REM
REM  Run it from the project folder. PowerShell will not run a script
REM  from the current directory without the .\ prefix:
REM
REM      .\deploy                    PowerShell
REM      .\deploy "what changed"     PowerShell, with a commit message
REM      deploy "what changed"       cmd.exe, or double-click the file
REM ---------------------------------------------------------------
setlocal
cd /d "%~dp0"

set "MSG=%~1"
if "%MSG%"=="" set "MSG=Update Timberhold"

echo.
echo === Checking the build ===
REM GitHub Pages is published by the CI workflow, so it is protected either
REM way. Firebase is deployed straight from this machine further down, so
REM without this check a broken build would go live there unnoticed.
if not exist "node_modules\playwright" goto :nocheck
where node >nul 2>nul
if errorlevel 1 goto :nocheck
call node scripts\verify.js
if errorlevel 1 goto :badbuild
goto :staged

:nocheck
echo Skipped - local checks need Node plus a one-time setup:
echo     npm install ^&^& npx playwright install chromium
echo GitHub Actions will still check this push.

:staged
echo.
echo === Staging changes ===
git add -A
if errorlevel 1 goto :fail

git diff --cached --quiet
if errorlevel 1 (
  git commit -m "%MSG%"
  if errorlevel 1 goto :fail
) else (
  echo Nothing new to commit - checking for unpushed commits...
)

echo.
echo === Pushing to GitHub ===
git push origin main
if errorlevel 1 goto :fail

echo.
echo === Publishing ===
echo GitHub Pages is published by the workflow once its checks pass:
echo   https://github.com/Josh2030/timberhold/actions
echo   https://josh2030.github.io/timberhold/

where firebase >nul 2>nul
if errorlevel 1 goto :done
echo.
echo Firebase CLI found - deploying hosting + Firestore rules.
echo (The rules are what let signed-in players load their saved camp.)
call firebase deploy --only hosting,firestore:rules
if errorlevel 1 goto :fail

:done
echo.
echo === Done ===
echo Live at https://timberhold-a6554.web.app (hard-refresh with Ctrl+F5).
echo.
pause
exit /b 0

:badbuild
echo.
echo *** The build did NOT pass its checks - nothing was pushed. ***
echo Fix the problems listed above and run this again.
echo.
pause
exit /b 1

:fail
echo.
echo *** Deploy FAILED - see the error above. ***
echo.
echo   "could not read Username"  -^> run:  git push origin main
echo                                 and sign in when GitHub asks.
echo   "index.lock: File exists"  -^> a previous git run left a lock behind.
echo                                 Close any git/editor windows, then run:
echo                                 del .git\index.lock
echo.
pause
exit /b 1
