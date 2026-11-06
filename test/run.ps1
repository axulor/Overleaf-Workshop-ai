# Runs the tests in an isolated VS Code. They use a fake Overleaf and need no account.
param(
  [string]$ExtensionDir = (Split-Path -Parent $PSScriptRoot),
  [string[]]$Suites = @('compile-tests.js', 'sync-tests.js', 'activation-tests.js')
)

$run = Join-Path $PSScriptRoot '.run'
$exe = Join-Path (Split-Path (Split-Path (Get-Command code).Source)) 'Code.exe'
if (-not (Test-Path -LiteralPath $exe)) { "Code.exe not found at $exe"; exit 1 }

# A terminal inside VS Code passes these on, and they would change how the new instance starts.
Get-ChildItem Env: | Where-Object { $_.Name -like 'VSCODE_*' -or $_.Name -eq 'ELECTRON_RUN_AS_NODE' } | ForEach-Object { Remove-Item "Env:$($_.Name)" }
$env:OVERLEAF_AI_TEST_DIR = $run

$failed = $false
foreach ($suite in $Suites) {
  "=== $suite ==="
  foreach ($d in 'user-data', 'extensions', 'workspace') {
    Remove-Item -LiteralPath (Join-Path $run $d) -Recurse -Force -ErrorAction SilentlyContinue
  }
  New-Item -ItemType Directory -Force -Path (Join-Path $run 'user-data\User'), (Join-Path $run 'extensions'), (Join-Path $run 'workspace') | Out-Null
  $results = Join-Path $run 'results.txt'
  $progress = Join-Path $run 'progress.txt'
  Remove-Item -LiteralPath $results, $progress -ErrorAction SilentlyContinue
  if ($suite -eq 'activation-tests.js') {
    $linked = Join-Path $run 'workspace\overleaf-My Paper\.overleaf'
    New-Item -ItemType Directory -Force -Path $linked | Out-Null
    '{ "uri": "overleaf-workshop://www.overleaf.com/My%20Paper?user=u&project=p", "enableCompileNPreview": true }' | Set-Content -LiteralPath (Join-Path $linked 'settings.json') -Encoding ASCII
  }
  '{ "security.workspace.trust.enabled": false, "workbench.startupEditor": "none" }' | Set-Content -LiteralPath (Join-Path $run 'user-data\User\settings.json') -Encoding ASCII

  $arguments = @(
    "--user-data-dir=`"$run\user-data`"", "--extensions-dir=`"$run\extensions`"",
    "--extensionDevelopmentPath=`"$ExtensionDir`"", "--extensionDevelopmentPath=`"$PSScriptRoot\fixtures\latex-workshop-stub`"",
    "--extensionTestsPath=`"$PSScriptRoot\$suite`"",
    '--skip-welcome', '--skip-release-notes', '--disable-updates', '--new-window', "`"$run\workspace`""
  )
  $process = Start-Process -FilePath $exe -ArgumentList $arguments -PassThru
  $clock = [Diagnostics.Stopwatch]::StartNew()
  while (-not (Test-Path -LiteralPath $results) -and $clock.Elapsed.TotalSeconds -lt 540) { Start-Sleep -Seconds 1 }
  Start-Sleep -Seconds 2
  if (-not $process.HasExited) { Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue }

  if (-not (Test-Path -LiteralPath $results)) {
    'ERROR no results: the test run timed out. It had got as far as:'
    Get-Content -LiteralPath $progress -Encoding UTF8 -Tail 5 -ErrorAction SilentlyContinue
    $failed = $true
    continue
  }
  $rows = @(Get-Content -LiteralPath $results -Encoding UTF8)
  $rows | Where-Object { $_ -match '^(FAIL|ERROR)|^\s+at ' }
  $pass = @($rows | Where-Object { $_ -like 'PASS*' }).Count
  $fail = @($rows | Where-Object { $_ -match '^(FAIL|ERROR)' }).Count
  "passed $pass, failed $fail, $([int]$clock.Elapsed.TotalSeconds) s"
  if ($fail -gt 0 -or $pass -eq 0) { $failed = $true }
}
if ($failed) { exit 1 }
