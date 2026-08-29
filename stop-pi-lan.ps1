param(
	[Parameter(Position = 0)]
	[string]$Workspace,
	[switch]$NoDialog
)

$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Windows.Forms
$sessionDirectory = Join-Path $env:LOCALAPPDATA "PiAgents\lan-sessions"

function Show-Result([string]$Message) {
	if ($NoDialog) {
		return
	}
	[void][System.Windows.Forms.MessageBox]::Show(
		$Message,
		"Pi LAN server",
		[System.Windows.Forms.MessageBoxButtons]::OK,
		[System.Windows.Forms.MessageBoxIcon]::Information
	)
}

if (-not (Test-Path -LiteralPath $sessionDirectory)) {
	Write-Output "No Pi LAN launcher sessions are running"
	Show-Result "No Pi LAN launcher sessions are running."
	exit 0
}

$resolvedWorkspace = if ($Workspace) { (Resolve-Path -LiteralPath $Workspace -ErrorAction Stop).Path } else { $null }
$stopped = 0
foreach ($file in Get-ChildItem -LiteralPath $sessionDirectory -Filter "*.json" -File) {
	try {
		$session = Get-Content -LiteralPath $file.FullName -Raw | ConvertFrom-Json
		if ($resolvedWorkspace -and $session.workspace -ne $resolvedWorkspace) {
			continue
		}
		$rootProcess = Get-CimInstance Win32_Process -Filter "ProcessId = $($session.processId)" -ErrorAction SilentlyContinue
		if ($rootProcess -and $rootProcess.CommandLine -like "*pi-test.ps1*--serve*") {
			$processes = @(Get-CimInstance Win32_Process)
			$descendants = New-Object System.Collections.Generic.List[int]
			$pending = New-Object System.Collections.Generic.Queue[int]
			$pending.Enqueue([int]$session.processId)
			while ($pending.Count -gt 0) {
				$parentId = $pending.Dequeue()
				foreach ($child in $processes | Where-Object { $_.ParentProcessId -eq $parentId }) {
					$descendants.Add([int]$child.ProcessId)
					$pending.Enqueue([int]$child.ProcessId)
				}
			}
			for ($index = $descendants.Count - 1; $index -ge 0; $index--) {
				Stop-Process -Id $descendants[$index] -Force -ErrorAction SilentlyContinue
			}
			Stop-Process -Id $session.processId -Force -ErrorAction SilentlyContinue
			$stopped++
			Write-Output "Stopped Pi for $($session.workspace) on port $($session.port)"
		}
		Remove-Item -LiteralPath $file.FullName -Force
	} catch {
		Write-Warning "Could not stop the session recorded in $($file.FullName): $($_.Exception.Message)"
	}
}

if ($stopped -eq 0) {
	Write-Output "No matching Pi LAN launcher sessions are running"
	Show-Result "No matching Pi LAN launcher sessions are running."
} else {
	Show-Result "Stopped $stopped Pi LAN server session(s)."
}
