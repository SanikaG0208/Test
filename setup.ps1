$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$backend = Join-Path $root 'backend'
$frontend = Join-Path $root 'frontend'

function Require-Command($name, $message) {
  if (-not (Get-Command $name -ErrorAction SilentlyContinue)) {
    throw $message
  }
}

Require-Command 'node' 'Node.js 18 or newer is required. Install it from https://nodejs.org/.'
Require-Command 'npm.cmd' 'npm is required. Reinstall Node.js if npm.cmd is missing.'
Require-Command 'psql' 'PostgreSQL and its command-line tools are required. Install PostgreSQL, then reopen PowerShell.'

$nodeMajor = [int]((node --version).TrimStart('v').Split('.')[0])
if ($nodeMajor -lt 18) { throw "Node.js 18 or newer is required. Found Node.js $nodeMajor." }

if (-not (Test-Path (Join-Path $backend '.env'))) {
  Copy-Item (Join-Path $backend '.env.example') (Join-Path $backend '.env')
  Write-Host 'Created backend/.env from backend/.env.example.' -ForegroundColor Yellow
  Write-Host 'Open backend/.env and replace every placeholder with your GitHub and PostgreSQL values.' -ForegroundColor Yellow
  Read-Host 'Press Enter after you have completed backend/.env'
}

Push-Location $backend
try { npm.cmd install } finally { Pop-Location }
Push-Location $frontend
try { npm.cmd install } finally { Pop-Location }

Push-Location $backend
try {
  node -e "require('dotenv').config(); if (!process.env.DATABASE_URL) { throw new Error('DATABASE_URL is missing from backend/.env'); } console.log('Environment configuration found.');"
  node -e "require('dotenv').config(); const { PostgresStore } = require('./postgresStore'); (async () => { const store = new PostgresStore(); await store.init(); await store.close(); console.log('PostgreSQL connection verified.'); })().catch((error) => { console.error(error.message); process.exit(1); });"
} finally { Pop-Location }

Write-Host 'Starting backend and frontend...' -ForegroundColor Green
Start-Process powershell -WorkingDirectory $backend -ArgumentList '-NoExit', '-Command', 'npm.cmd start'
Start-Process powershell -WorkingDirectory $frontend -ArgumentList '-NoExit', '-Command', 'npm.cmd run dev'
Write-Host 'Backend: http://localhost:5000' -ForegroundColor Cyan
Write-Host 'Frontend: http://localhost:5173' -ForegroundColor Cyan