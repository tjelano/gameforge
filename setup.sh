#!/usr/bin/env bash
# GameForge one-click setup (macOS/Linux/WSL/Git Bash).
set -e

echo "GameForge setup"
echo "----------------"

if ! command -v git >/dev/null 2>&1; then
  echo "❌ git is not installed. GameForge is git-native — install git first."
  exit 1
fi

if [ ! -d .git ]; then
  echo "⚠️  Not a git repository yet. Initializing..."
  git init
fi

if ! git remote get-url origin >/dev/null 2>&1; then
  echo "⚠️  No 'origin' remote configured. Git sync (Push/Pull) won't work until you add one:"
  echo "    git remote add origin <your-repo-url>"
else
  echo "✅ origin remote: $(git remote get-url origin)"
fi

if [ ! -f .env.local ]; then
  cp .env.local.example .env.local
  echo "✅ Created .env.local from .env.local.example — fill in real values before generating real art."
fi

echo "Installing dependencies..."
npm install

mkdir -p data/styles data/assets storage/images storage/exports
touch data/styles/.gitkeep data/assets/.gitkeep storage/images/.gitkeep

echo ""
echo "✅ Setup complete."
echo "   Run 'npm run dev' and 'npm run dev:worker' in two terminals to start."
