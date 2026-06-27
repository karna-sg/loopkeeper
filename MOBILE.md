# Loopkeeper on your iPhone (free Apple ID + cloud backend)

End-to-end runbook to go from "runs in the simulator" → **working on your iPhone 17 Pro**. This
path needs **no paid Apple Developer account** and **no Xcode GUI**. Nudges are on-device local
notifications (push/APNs would need the paid program — that's a later upgrade).

Order: deploy the backend → connect accounts → put the app on the phone → point it at the backend.

---

## 1. Deploy the backend (always-on)

> **Chosen path: AWS Lightsail — see [`AWS.md`](./AWS.md).** Persistent (tokens/loops survive
> restarts), always-on, no domain needed (Caddy + sslip.io HTTPS), ~$7/mo on your AWS credits.
> The Fly.io steps below are an alternative.

### Alternative — Fly.io
```sh
brew install flyctl && fly auth login
cd /Users/karna/tools/loopkeeper
fly launch --no-deploy --copy-config --name loopkeeper-backend   # uses fly.toml + Dockerfile
fly volumes create loopkeeper_data --size 1 --region sin
```
Set secrets (generate a strong API token; the app will send it):
```sh
fly secrets set \
  LOOPKEEPER_API_TOKEN="$(openssl rand -hex 24)" \
  OPENAI_API_KEY="sk-..." \
  SLACK_CLIENT_ID="..."  SLACK_CLIENT_SECRET="..." \
  GOOGLE_CLIENT_ID="..." GOOGLE_CLIENT_SECRET="..." \
  LOOPKEEPER_PUBLIC_URL="https://loopkeeper-backend.fly.dev"
# Provider auto-selects to OpenAI because OPENAI_API_KEY is set (override with LLM_PROVIDER).
# To use Claude instead: set ANTHROPIC_API_KEY and LLM_PROVIDER=anthropic.
fly deploy
fly secrets list            # confirm; note the token value you set (you'll type it into the app)
curl https://loopkeeper-backend.fly.dev/healthz   # should return ok:true
```

### Credentials you need first
- **Slack app** (api.slack.com/apps → Create): add the user scopes the backend requests
  (`channels:history, groups:history, im:history, mpim:history, search:read, users:read`), and
  redirect URL `https://loopkeeper-backend.fly.dev/auth/slack/callback`.
- **Google Cloud OAuth** (console.cloud.google.com → APIs & Services → Credentials): OAuth client
  (Web), scope `gmail.readonly`, redirect `https://loopkeeper-backend.fly.dev/auth/google/callback`.
  Keep the consent screen in **Testing** and add yourself as a test user (no CASA audit needed;
  refresh token re-auths weekly — fine for one user).
- **OpenAI API key** for extraction (or an Anthropic key + `LLM_PROVIDER=anthropic`).

## 2. Connect your accounts (from any browser)
Open these once and approve (read-only):
```
https://loopkeeper-backend.fly.dev/auth/slack
https://loopkeeper-backend.fly.dev/auth/google
```
Then trigger the first scan + check it worked:
```sh
TOKEN=<the LOOPKEEPER_API_TOKEN you set>
curl -X POST -H "Authorization: Bearer $TOKEN" https://loopkeeper-backend.fly.dev/scan
curl     -H "Authorization: Bearer $TOKEN" https://loopkeeper-backend.fly.dev/brief
```
(The backend auto-scans every 2h after this.)

## 3. Put the app on the iPhone (free Apple ID, no Xcode GUI)
```sh
bash /Users/karna/tools/loopkeeper/ios/build-ipa.sh   # -> ios/Loopkeeper.ipa
```
- Install **Sideloadly** (https://sideloadly.io). Plug in the iPhone, drop `Loopkeeper.ipa` in,
  sign in with your **free Apple ID**, Start. It signs + installs the app (valid 7 days).
- On the iPhone: **Settings ▸ General ▸ VPN & Device Management** → trust your developer cert.
- Re-run `build-ipa.sh` + Sideloadly weekly to refresh the signature (or use SideStore for
  auto-refresh over Wi-Fi).

## 4. Point the app at your backend
In the app → **⚙ Settings**:
- **Backend URL:** `https://loopkeeper-backend.fly.dev`
- **API token:** the `LOOPKEEPER_API_TOKEN` value
- Tap **Apply & refresh** → your real loops appear.
- Tap **Enable reminders** → grant notifications. The app schedules on-device reminders at 9am
  for anything due, so nothing slips even with a free account.

---

## What "working" looks like
Backend scans Slack + Gmail every 2h → extracts commitments/requests/deadlines → the app shows them
in one minimal list (Overdue / Today / Upcoming / No date / Awaiting), and on-device reminders fire
before each is due. Swipe Done/Snooze/Dismiss; open a loop for a suggested follow-up draft.

## Upgrade later (paid Apple Developer, $99/yr)
Unlocks **real push nudges** (server-side, fire even when the app is closed) + TestFlight installs
(no weekly re-sign). The backend already has the APNs path — set `APNS_*` secrets and
`LOOPKEEPER_NUDGE_EVERY_MIN=60`, add the Push capability, and it works.
