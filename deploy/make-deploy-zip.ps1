<#
  Builds a clean deployment zip of .next (no build cache inside) for manual
  upload to the HostFly cPanel account via File Manager.

  Usage (from the repo root, in PowerShell):
      npm run build
      .\deploy\make-deploy-zip.ps1

  Produces: deploy\kvaterka-build.zip
  Upload that file to /home/kvaterk1/kvaterka via cPanel File Manager, then
  Extract it there (target path "/kvaterka") - see HOW_TO_UPDATE_THE_SITE.md.
#>

$ErrorActionPreference = 'Stop'

$repoRoot = Split-Path -Parent $PSScriptRoot
$nextDir  = Join-Path $repoRoot '.next'
$stageDir = Join-Path $repoRoot 'deploy\_stage\.next'
$zipPath  = Join-Path $repoRoot 'deploy\kvaterka-build.zip'

if (-not (Test-Path $nextDir)) {
    throw "No .next folder found. Run npm run build first."
}

Write-Host "Staging a cache-free copy of .next ..."
if (Test-Path (Join-Path $repoRoot 'deploy\_stage')) {
    Remove-Item (Join-Path $repoRoot 'deploy\_stage') -Recurse -Force
}
New-Item -ItemType Directory -Path $stageDir -Force | Out-Null

robocopy $nextDir $stageDir /E /XD cache /NFL /NDL /NJH /NJS /NC /NS | Out-Null
if ($LASTEXITCODE -ge 8) {
    throw "robocopy failed copying .next (exit code $LASTEXITCODE)"
}

if (Test-Path $zipPath) { Remove-Item $zipPath -Force }

Write-Host "Zipping ..."
Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem
# ZIP entry names use forward slashes. ZipFile.CreateFromDirectory in Windows
# PowerShell 5.1 writes backslashes, which unzip on the host reads as part of the
# file name (and deploy/apply-release.sh cannot find .next/BUILD_ID), so the
# entries are written one by one with the separator fixed. Entries are relative
# to deploy\_stage, so the archive extracts as .next/...
$stageRoot = Join-Path $repoRoot 'deploy\_stage'
$zip = [System.IO.Compression.ZipFile]::Open($zipPath, [System.IO.Compression.ZipArchiveMode]::Create)
try {
    Get-ChildItem $stageRoot -Recurse -File | ForEach-Object {
        $entryName = $_.FullName.Substring($stageRoot.Length + 1).Replace('\', '/')
        [System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile(
            $zip, $_.FullName, $entryName, [System.IO.Compression.CompressionLevel]::Optimal
        ) | Out-Null
    }
} finally {
    $zip.Dispose()
}

Remove-Item (Join-Path $repoRoot 'deploy\_stage') -Recurse -Force

$sizeMb = [Math]::Round((Get-Item $zipPath).Length / 1MB, 2)
Write-Host "Done: $zipPath ($sizeMb MB)"
Write-Host "Upload this file to /home/kvaterk1/kvaterka via cPanel File Manager and extract it there."
