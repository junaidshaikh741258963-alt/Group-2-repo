# Phase 1 reorg helper: lib/ai/* and lib/cache/* moves + import rewrites.
$ErrorActionPreference = "Stop"
$root = "C:\2. FODS Project\ai-travel-planner"
Set-Location $root

$aiNames = @('aiPrompt', 'aiIntent', 'aiReply', 'aiSchema')

New-Item -ItemType Directory -Force -Path src\lib\ai | Out-Null
foreach ($n in $aiNames) {
  $from = "src\lib\$n.ts"
  if (Test-Path $from) { Move-Item $from "src\lib\ai\$n.ts" }
  else { Write-Host "MISSING: $from (already moved?)" }
}

New-Item -ItemType Directory -Force -Path src\lib\cache | Out-Null
if (Test-Path "src\server\cache.ts") { Move-Item "src\server\cache.ts" "src\lib\cache\index.ts" }

$utf8 = New-Object System.Text.UTF8Encoding($false)
$files = Get-ChildItem src -Recurse -File | Where-Object { $_.Extension -in ".ts", ".tsx" }
$changed = 0
foreach ($f in $files) {
  $text = [System.IO.File]::ReadAllText($f.FullName)
  $orig = $text
  foreach ($n in $aiNames) { $text = $text.Replace('@/lib/' + $n, '@/lib/ai/' + $n) }
  $text = $text.Replace('@/server/cache', '@/lib/cache')
  if ($text -ne $orig) {
    [System.IO.File]::WriteAllText($f.FullName, $text, $utf8)
    $changed++
  }
}
Write-Host "lib reorganized: moved $($aiNames.Count + 1) files, rewrote $changed imports"
