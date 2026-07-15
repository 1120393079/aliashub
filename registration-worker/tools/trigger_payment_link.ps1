# Trigger protocol-mode payment_link for an existing account.
# Usage: .\tools\trigger_payment_link.ps1 -AccountId <account-id> -SmsPoolFile .\sms-pool.txt

param(
    [Parameter(Mandatory=$true)][int]$AccountId,
    [string]$BaseUrl = "http://127.0.0.1:8000",
    [string]$SmsPoolFile = ""
)

if ($SmsPoolFile) {
    if (-not (Test-Path -LiteralPath $SmsPoolFile -PathType Leaf)) {
        throw "SMS pool file does not exist"
    }
    $smsPool = Get-Content -LiteralPath $SmsPoolFile -Raw
} elseif ($env:CHATGPT_PAYMENT_SMS_POOL) {
    $smsPool = $env:CHATGPT_PAYMENT_SMS_POOL
} else {
    throw "SMS pool is required; use -SmsPoolFile or CHATGPT_PAYMENT_SMS_POOL"
}

if ([string]::IsNullOrWhiteSpace($smsPool)) {
    throw "SMS pool must not be empty"
}

$body = @{
    params = @{
        plan             = "plus"
        country          = "US"
        currency         = "USD"
        auto_checkout    = "true"
        payment_method   = "paypal"
        checkout_mode    = "protocol"
        headless         = "true"
        sms_pool         = $smsPool
        checkout_timeout = 300
    }
} | ConvertTo-Json -Depth 5

Write-Host "POST payment_link action"
$response = Invoke-WebRequest `
    -Uri "$($BaseUrl.TrimEnd('/'))/api/actions/chatgpt/$AccountId/payment_link" `
    -Method POST `
    -ContentType "application/json" `
    -Body $body `
    -TimeoutSec 30 `
    -UseBasicParsing
Write-Host "STATUS=$($response.StatusCode)"
$task = $response.Content | ConvertFrom-Json
Write-Host "task_id=$($task.id)"
Write-Host "status=$($task.status)"
$task | ConvertTo-Json -Depth 5
