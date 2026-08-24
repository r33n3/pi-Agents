$ErrorActionPreference = "Stop"

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$noEnv = $false
$forwardArgs = New-Object System.Collections.Generic.List[string]

foreach ($arg in $args) {
	if ($arg -eq "--no-env") {
		$noEnv = $true
	} else {
		$forwardArgs.Add($arg)
	}
}

$localEnvPath = Join-Path $scriptDir ".env.local"
if (-not $noEnv -and (Test-Path -LiteralPath $localEnvPath)) {
	foreach ($line in Get-Content -LiteralPath $localEnvPath) {
		if ($line -notmatch '^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$') {
			continue
		}
		$name = $Matches[1]
		$value = $Matches[2].Trim()
		if (($value.StartsWith('"') -and $value.EndsWith('"')) -or ($value.StartsWith("'") -and $value.EndsWith("'"))) {
			$value = $value.Substring(1, $value.Length - 2)
		}
		[Environment]::SetEnvironmentVariable($name, $value, "Process")
	}

	if (-not $env:OPENAI_API_KEY -and $env:OPENAI_PLATFORM_API) {
		$env:OPENAI_API_KEY = $env:OPENAI_PLATFORM_API
	}
	if (-not $env:ANTHROPIC_API_KEY -and $env:ANTHROPIC_PLATFORM_API) {
		$env:ANTHROPIC_API_KEY = $env:ANTHROPIC_PLATFORM_API
	}
}

if ($noEnv) {
	$env:PI_DISABLE_LOCAL_TOOL_ENV = "1"
	$envVarsToUnset = @(
		"ANTHROPIC_API_KEY",
		"ANTHROPIC_OAUTH_TOKEN",
		"OPENAI_API_KEY",
		"GEMINI_API_KEY",
		"GROQ_API_KEY",
		"CEREBRAS_API_KEY",
		"XAI_API_KEY",
		"OPENROUTER_API_KEY",
		"ZAI_API_KEY",
		"MISTRAL_API_KEY",
		"MINIMAX_API_KEY",
		"MINIMAX_CN_API_KEY",
		"AI_GATEWAY_API_KEY",
		"OPENCODE_API_KEY",
		"COPILOT_GITHUB_TOKEN",
		"GH_TOKEN",
		"GITHUB_TOKEN",
		"HF_TOKEN",
		"GOOGLE_APPLICATION_CREDENTIALS",
		"GOOGLE_CLOUD_PROJECT",
		"GCLOUD_PROJECT",
		"GOOGLE_CLOUD_LOCATION",
		"AWS_PROFILE",
		"AWS_ACCESS_KEY_ID",
		"AWS_SECRET_ACCESS_KEY",
		"AWS_SESSION_TOKEN",
		"AWS_REGION",
		"AWS_DEFAULT_REGION",
		"AWS_BEARER_TOKEN_BEDROCK",
		"AWS_CONTAINER_CREDENTIALS_RELATIVE_URI",
		"AWS_CONTAINER_CREDENTIALS_FULL_URI",
		"AWS_WEB_IDENTITY_TOKEN_FILE",
		"AZURE_OPENAI_API_KEY",
		"AZURE_OPENAI_BASE_URL",
		"AZURE_OPENAI_RESOURCE_NAME",
		"OPENAI_PLATFORM_API",
		"ANTHROPIC_PLATFORM_API",
		"APIFY_API_KEY",
		"CURRENTS_NEW_API_KEY",
		"FINNHUB_API_KEY",
		"FIRECRAWL_API_KEY",
		"FIRECRAWL_BASE_URL",
		"SEARXNG_BASE_URL",
		"TIINGO_API_KEY"
	)

	foreach ($name in $envVarsToUnset) {
		Remove-Item -Path "Env:$name" -ErrorAction SilentlyContinue
	}

	Write-Host "Running without API keys..."
}

$tsxBin = Join-Path $scriptDir "node_modules/.bin/tsx.cmd"
if (-not (Test-Path -LiteralPath $tsxBin)) {
	throw "tsx not found at $tsxBin. Run npm install from the repo root first."
}

$cliPath = Join-Path $scriptDir "packages/coding-agent/src/cli.ts"
& $tsxBin $cliPath @forwardArgs
$exitCode = $LASTEXITCODE
if ($exitCode -ne 0) {
	exit $exitCode
}
