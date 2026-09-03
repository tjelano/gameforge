@echo off
REM GameForge one-click setup (Windows).
setlocal enabledelayedexpansion

echo GameForge setup
echo ----------------

where git >nul 2>&1
if errorlevel 1 (
  echo X git is not installed. GameForge is git-native - install git first.
  exit /b 1
)

if not exist ".git" (
  echo Not a git repository yet. Initializing...
  git init
)

git remote get-url origin >nul 2>&1
if errorlevel 1 (
  echo No 'origin' remote configured. Git sync ^(Push/Pull^) won't work until you add one:
  echo     git remote add origin ^<your-repo-url^>
) else (
  for /f "delims=" %%r in ('git remote get-url origin') do echo origin remote: %%r
)

if not exist ".env.local" (
  copy .env.local.example .env.local >nul
  echo Created .env.local from .env.local.example - fill in real values before generating real art.
)

echo Installing dependencies...
call npm install

if not exist "data\styles" mkdir data\styles
if not exist "data\assets" mkdir data\assets
if not exist "storage\images" mkdir storage\images
if not exist "storage\exports" mkdir storage\exports
type nul > data\styles\.gitkeep
type nul > data\assets\.gitkeep
type nul > storage\images\.gitkeep

echo.
echo Setup complete.
echo Run "npm run dev" and "npm run dev:worker" in two terminals to start.
