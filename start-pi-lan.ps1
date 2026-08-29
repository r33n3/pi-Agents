param(
	[Parameter(Position = 0)]
	[string]$Workspace,
	[ValidateRange(0, 65535)]
	[int]$Port = 0,
	[switch]$NoOpen,
	[switch]$NoDialog
)

$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Windows.Forms
$repoRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$piLauncher = Join-Path $repoRoot "pi-test.ps1"
$sessionDirectory = Join-Path $env:LOCALAPPDATA "PiAgents\lan-sessions"

function Show-Result([string]$Message, [string]$Title, [System.Windows.Forms.MessageBoxIcon]$Icon) {
	if ($NoDialog) {
		return
	}
	[void][System.Windows.Forms.MessageBox]::Show(
		$Message,
		$Title,
		[System.Windows.Forms.MessageBoxButtons]::OK,
		$Icon
	)
}

function Select-Workspace {
	$picker = New-Object System.Windows.Forms.FolderBrowserDialog
	$picker.Description = "Select the workspace Pi should use"
	$picker.ShowNewFolderButton = $true
	if ($picker.ShowDialog() -ne [System.Windows.Forms.DialogResult]::OK) {
		return $null
	}
	return $picker.SelectedPath
}

function Test-PortAvailable([int]$Candidate) {
	$listener = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Any, $Candidate)
	try {
		$listener.Start()
		return $true
	} catch {
		return $false
	} finally {
		$listener.Stop()
	}
}

function Test-PrivateAddress([string]$Address) {
	return $Address -match '^10\.' -or
		$Address -match '^192\.168\.' -or
		$Address -match '^172\.(1[6-9]|2[0-9]|3[01])\.'
}

function Get-LanAddress {
	try {
		$routes = Get-NetRoute -AddressFamily IPv4 -DestinationPrefix "0.0.0.0/0" -ErrorAction Stop |
			Where-Object { $_.State -eq "Alive" } |
			Sort-Object RouteMetric, InterfaceMetric
		foreach ($route in $routes) {
			$addresses = Get-NetIPAddress -AddressFamily IPv4 -InterfaceIndex $route.InterfaceIndex -ErrorAction SilentlyContinue
			foreach ($address in $addresses) {
				if (Test-PrivateAddress $address.IPAddress) {
					return $address.IPAddress
				}
			}
		}
	} catch {
		# Fall through to the broader adapter scan.
	}
	$address = Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue |
		Where-Object { Test-PrivateAddress $_.IPAddress } |
		Select-Object -First 1 -ExpandProperty IPAddress
	return $address
}

function Get-TrackedSessions {
	if (-not (Test-Path -LiteralPath $sessionDirectory)) {
		return @()
	}
	$sessions = @()
	foreach ($file in Get-ChildItem -LiteralPath $sessionDirectory -Filter "*.json" -File) {
		try {
			$session = Get-Content -LiteralPath $file.FullName -Raw | ConvertFrom-Json
			$process = Get-CimInstance Win32_Process -Filter "ProcessId = $($session.processId)" -ErrorAction SilentlyContinue
			if ($process -and $process.CommandLine -like "*pi-test.ps1*--serve*") {
				$sessions += $session
			} else {
				Remove-Item -LiteralPath $file.FullName -Force
			}
		} catch {
			Remove-Item -LiteralPath $file.FullName -Force -ErrorAction SilentlyContinue
		}
	}
	return $sessions
}

try {
	if (-not (Test-Path -LiteralPath $piLauncher -PathType Leaf)) {
		throw "Pi launcher not found at $piLauncher"
	}
	if (-not $Workspace) {
		$Workspace = Select-Workspace
		if (-not $Workspace) {
			exit 0
		}
	}
	$resolvedWorkspace = (Resolve-Path -LiteralPath $Workspace -ErrorAction Stop).Path
	if (-not (Test-Path -LiteralPath $resolvedWorkspace -PathType Container)) {
		throw "Workspace is not a directory: $resolvedWorkspace"
	}

	New-Item -ItemType Directory -Path $sessionDirectory -Force | Out-Null
	$existing = Get-TrackedSessions | Where-Object { $_.workspace -eq $resolvedWorkspace } | Select-Object -First 1
	if ($existing) {
		Set-Clipboard -Value $existing.lanUrl
		if (-not $NoOpen) {
			Start-Process $existing.localUrl
		}
		Write-Output "Pi is already serving $resolvedWorkspace"
		Write-Output "LAN: $($existing.lanUrl)"
		Show-Result "Pi is already serving this workspace.`n`n$($existing.lanUrl)`n`nThe LAN URL was copied to the clipboard." "Pi LAN server" ([System.Windows.Forms.MessageBoxIcon]::Information)
		exit 0
	}

	if ($Port -eq 0) {
		$Port = 4173..4182 | Where-Object { Test-PortAvailable $_ } | Select-Object -First 1
		if (-not $Port) {
			throw "No available Pi LAN port in the range 4173-4182"
		}
	} elseif (-not (Test-PortAvailable $Port)) {
		throw "Port $Port is already in use"
	}

	$randomBytes = New-Object byte[] 32
	$random = [System.Security.Cryptography.RandomNumberGenerator]::Create()
	try {
		$random.GetBytes($randomBytes)
	} finally {
		$random.Dispose()
	}
	$token = [Convert]::ToBase64String($randomBytes).TrimEnd("=").Replace("+", "-").Replace("/", "_")
	$env:PI_SERVE_TOKEN = $token
	$env:TSX_TSCONFIG_PATH = Join-Path $repoRoot "tsconfig.json"
	$arguments = @(
		"-NoProfile",
		"-ExecutionPolicy", "Bypass",
		"-File", "`"$piLauncher`"",
		"--serve",
		"--serve-host", "0.0.0.0",
		"--serve-port", $Port
	)
	$process = Start-Process -FilePath "powershell.exe" -ArgumentList $arguments -WorkingDirectory $resolvedWorkspace -WindowStyle Hidden -PassThru
	$lanAddress = Get-LanAddress
	$localUrl = "http://127.0.0.1:$Port/?token=$token"
	$lanUrl = if ($lanAddress) { "http://${lanAddress}:$Port/?token=$token" } else { $localUrl }
	$statusPath = Join-Path $sessionDirectory "$($process.Id).json"
	@{
		processId = $process.Id
		workspace = $resolvedWorkspace
		port = $Port
		localUrl = $localUrl
		lanUrl = $lanUrl
		startedAt = (Get-Date).ToString("o")
	} | ConvertTo-Json | Set-Content -LiteralPath $statusPath -Encoding UTF8

	$ready = $false
	for ($attempt = 0; $attempt -lt 60; $attempt++) {
		if ($process.HasExited) {
			break
		}
		try {
			$response = Invoke-WebRequest -UseBasicParsing -Uri $localUrl -TimeoutSec 1
			if ($response.StatusCode -eq 200) {
				$ready = $true
				break
			}
		} catch {
			Start-Sleep -Milliseconds 250
		}
	}
	if (-not $ready) {
		Remove-Item -LiteralPath $statusPath -Force -ErrorAction SilentlyContinue
		if (-not $process.HasExited) {
			Stop-Process -Id $process.Id -Force
		}
		throw "Pi did not become ready on port $Port"
	}

	Set-Clipboard -Value $lanUrl
	if (-not $NoOpen) {
		Start-Process $localUrl
	}
	Write-Output "Pi is serving $resolvedWorkspace"
	Write-Output "LAN: $lanUrl"
	Write-Output "Stop: $repoRoot\stop-pi-lan.bat"
	Show-Result "Pi is running in the background for:`n$resolvedWorkspace`n`n$lanUrl`n`nThe LAN URL was copied to the clipboard." "Pi LAN server" ([System.Windows.Forms.MessageBoxIcon]::Information)
} catch {
	Write-Error $_
	Show-Result $_.Exception.Message "Pi LAN server failed" ([System.Windows.Forms.MessageBoxIcon]::Error)
	exit 1
}
