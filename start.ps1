$ErrorActionPreference = 'Stop'
$Node = (Get-Command node.exe -ErrorAction Stop).Source
$Entry = Join-Path $PSScriptRoot 'src\server\index.ts'
$Tsx = Join-Path $PSScriptRoot 'node_modules\tsx\dist\cli.mjs'
if (-not (Test-Path -LiteralPath $Node)) { throw 'Node.js 24.15+ is required.' }
if (-not (Test-Path -LiteralPath $Tsx)) { throw 'Install the locked project dependencies first.' }
if (-not (Test-Path -LiteralPath (Join-Path $PSScriptRoot 'dist\web\index.html'))) { throw 'Run npm run build before starting.' }
$env:NODE_ENV = 'production'
Write-Host 'Zhiyansi: http://127.0.0.1:3180  (Ctrl+C to stop this instance)'
& $Node $Tsx $Entry
exit $LASTEXITCODE
