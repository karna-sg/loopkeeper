# Deploy Loopkeeper on AWS Lightsail

The simplest AWS path for a persistent, always-on Node + SQLite app. One Lightsail Linux
instance runs the existing Docker image (data on its SSD survives restarts), and Caddy gives
it real HTTPS on a free `sslip.io` hostname — **no domain to buy**. ~$7/mo (≈14 months on $100
credits; first 3 months free for new Lightsail accounts).

## 1. Create the instance
- Lightsail console → **Create instance** → Linux/Unix → **OS Only → Ubuntu 24.04 LTS**.
- Region: **Mumbai (ap-south-1)** (matches the app's IST default).
- Plan: **$7/mo (1 GB RAM / 2 vCPU / 40 GB SSD)**. *(Avoid $5/512 MB — too tight for the build.)*
- Networking → **attach a Static IP** (free while attached). Say it's `13.49.22.7`.
  → your host is `13-49-22-7.sslip.io` (dots → dashes).
- Networking → **firewall**: add inbound **TCP 80** and **TCP 443**. Leave 8080 closed (Caddy
  reaches the app over the internal Docker network). SSH (22) is open by default.

## 2. Install Docker + get the code
SSH in (browser SSH button or your key), then:
```sh
sudo apt-get update && sudo apt-get install -y docker.io docker-compose-v2 git
sudo systemctl enable --now docker
sudo git clone <your-repo-url> /opt/loopkeeper
cd /opt/loopkeeper/deploy
```

## 3. Configure (secrets stay on the box, never in git)
```sh
# compose host var
cp .env.example .env
sed -i 's/^LK_HOST=.*/LK_HOST=13-49-22-7.sslip.io/' .env

# app secrets
cp loopkeeper.env.example loopkeeper.env && sudo chmod 600 loopkeeper.env
nano loopkeeper.env
```
In `loopkeeper.env` set:
- `LOOPKEEPER_PUBLIC_URL=https://13-49-22-7.sslip.io`
- `LOOPKEEPER_API_TOKEN=` → `openssl rand -hex 24`
- `LOOPKEEPER_MASTER_KEY=` → `openssl rand -base64 32` (generate once, keep forever)
- `OPENAI_API_KEY=` your key (provider auto-selects OpenAI)
- `SLACK_CLIENT_ID/SECRET`, `GOOGLE_CLIENT_ID/SECRET`

## 4. Launch
```sh
sudo docker compose up -d --build      # builds the image + starts app + Caddy
curl https://13-49-22-7.sslip.io/healthz
# → {"ok":true,...,"extraction":"configured (openai)"}
```
Caddy fetches the TLS cert automatically on first start (give it ~30s).

## 5. Connect accounts + the app
- In the **Slack** app and **Google Cloud** OAuth client, set redirect URIs to
  `https://13-49-22-7.sslip.io/auth/slack/callback` and `…/auth/google/callback`
  (must match `LOOPKEEPER_PUBLIC_URL` exactly).
- From your iPhone browser, visit `…/auth/slack` and `…/auth/google` to grant read-only access.
- In the **Loopkeeper app → Settings**: Backend URL `https://13-49-22-7.sslip.io`, API token =
  your `LOOPKEEPER_API_TOKEN`, **Apply & refresh**, then **Enable reminders**.

## Operations
- **Update:** `cd /opt/loopkeeper && sudo git pull && cd deploy && sudo docker compose up -d --build`
- **Logs:** `sudo docker compose logs -f loopkeeper`
- **Backup:** Lightsail → instance → **Snapshots** (or enable automatic snapshots) — protects
  `loops.db` / `tokens.enc` / `master.key` on the volume.
- **Data lives in** the `lk_data` Docker volume on the instance SSD; it survives
  `docker compose down`/restarts. Only deleting the instance (or the volume) loses it.

## Gotchas
- The app must bind `0.0.0.0` — the Dockerfile already sets `HOST=0.0.0.0`.
- A bare IP or `*.compute.amazonaws.com` **cannot** get a trusted cert; the `sslip.io` + Caddy
  step is required (self-signed fails on iPhone and breaks OAuth).
- If the image build runs out of memory on 1 GB, add swap once:
  `sudo fallocate -l 1G /swapfile && sudo chmod 600 /swapfile && sudo mkswap /swapfile && sudo swapon /swapfile`.
- Want a nicer URL later? Point a ~$12/yr domain at the static IP and set `LK_HOST` +
  `LOOPKEEPER_PUBLIC_URL` + OAuth redirects to it — Caddy re-issues automatically.
