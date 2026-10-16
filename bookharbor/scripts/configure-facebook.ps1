$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot
Set-Location ..
Write-Host 'Enter only NEW, rotated credentials. The prompts hide your input.'
Write-Host 'First: the App Secret from your Meta developer app.'
npx.cmd wrangler secret put FB_APP_SECRET
if ($LASTEXITCODE -ne 0) { throw 'App secret setup failed.' }
Write-Host 'Next: the Page access token for Page 61595323019908.'
npx.cmd wrangler secret put FB_PAGE_ACCESS_TOKEN
if ($LASTEXITCODE -ne 0) { throw 'Page token setup failed.' }
Write-Host 'Secrets saved. Configure Meta callback URL:'
Write-Host 'https://bookharbor-mis465.bookharbor-mis465.workers.dev/webhook'
Write-Host 'Your verify token is in work/OWNER-ACCESS.txt. Do not share that file.'
