# probe-asar-lock.ps1 - test which packaged asar files are currently locked (no deletion)
# ASCII output only.
$targets = @(
  'F:\xiaokong-projects\daweige-agent\release-v2\win-unpacked\resources\app.asar',
  'F:\xiaokong-projects\daweige-agent\release-v3\win-unpacked\resources\app.asar',
  'F:\xiaokong-projects\daweige-agent\release-v4\win-unpacked\resources\app.asar'
)
foreach ($t in $targets) {
  if (-not (Test-Path $t)) { Write-Output ("MISSING  " + $t); continue }
  try {
    $fs = [System.IO.File]::Open($t, 'Open', 'ReadWrite', 'None')
    $fs.Close()
    Write-Output ("FREE     " + $t)
  } catch {
    Write-Output ("LOCKED   " + $t + "  -- " + $_.Exception.Message.Split("`n")[0])
  }
}
