$ErrorActionPreference = "Stop"
if (-not (Get-Command cloudflared -ErrorAction SilentlyContinue)) {
  throw "cloudflared is not installed. Run: winget install --id Cloudflare.cloudflared"
}
Write-Host "Starting a temporary customer-interface preview for http://localhost:3000"
Write-Warning "This is temporary development access, not permanent production hosting. Press Ctrl+C to stop."
cloudflared tunnel --url http://localhost:3000 --no-autoupdate
