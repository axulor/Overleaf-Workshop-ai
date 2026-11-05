# Opens a separate VS Code with this build, for trying it against a real Overleaf account.
# It has its own profile, so your own VS Code, its extensions and the official Overleaf Workshop are not touched.
# Its login and logs stay in the profile folder below, outside the repository.
param([string]$ExtensionDir = (Split-Path -Parent $PSScriptRoot))

$profileDir = Join-Path $env:LOCALAPPDATA 'overleaf-workshop-ai-dev'
New-Item -ItemType Directory -Force -Path (Join-Path $profileDir 'user-data'), (Join-Path $profileDir 'extensions') | Out-Null

$exe = Join-Path (Split-Path (Split-Path (Get-Command code).Source)) 'Code.exe'
if (-not (Test-Path -LiteralPath $exe)) { "Code.exe not found at $exe"; exit 1 }

# A terminal inside VS Code passes these on, and they would change how the new instance starts.
Get-ChildItem Env: | Where-Object { $_.Name -like 'VSCODE_*' -or $_.Name -eq 'ELECTRON_RUN_AS_NODE' } | ForEach-Object { Remove-Item "Env:$($_.Name)" }

$arguments = @(
  "--user-data-dir=`"$profileDir\user-data`"", "--extensions-dir=`"$profileDir\extensions`"",
  "--extensionDevelopmentPath=`"$ExtensionDir`"", '--skip-welcome', '--skip-release-notes', '--new-window'
)
Start-Process -FilePath $exe -ArgumentList $arguments | Out-Null
"Opened. Compile records are written under $profileDir\user-data\logs"
