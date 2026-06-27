# Loopkeeper — next steps

## Where we are (2026-06-25)
Phases 0–2 done and green (93 tests): extraction engine, single-user backend (OAuth, encrypted
vault, SQLite store, Slack/Gmail ingestion, scan→gate→extract→store, REST API), APNs nudges,
draft chasers, conservative closure detection, an in-process scheduler, and a SwiftUI app that
**runs on the iPhone 17 Pro simulator** against the backend (demo data via `pnpm run seed`).

The gap from here to *"I use it on my phone every day"* is **credentials + on-device + a real
precision check** — plus two correctness gaps the review found.

**→ For the step-by-step "get it onto my iPhone" runbook, see [`MOBILE.md`](./MOBILE.md).**
Shipped since the plan: API auth, on-device local notifications (free-tier nudges), a minimal
HIG redesign of the UI, an unsigned `.ipa` build (`ios/build-ipa.sh`) for Sideloadly, and a
cloud deploy (`Dockerfile` + `fly.toml`) so the backend runs 24/7. Decision: **free Apple ID**
(no push; local notifications instead) + **cloud backend** on Fly.io.

Owner key: **[you]** = needs your accounts/keys/device · **[me]** = I can build now, no creds.

---

## Critical path (do these in order)

### A. Go live with real data — validates the whole premise
1. **[you] Create credentials.** Slack app (client id/secret + redirect `…/auth/slack/callback`),
   Google Cloud OAuth in **Testing** mode (gmail.readonly), and `ANTHROPIC_API_KEY`. I'll write a
   click-by-click setup guide. *(blocks 2)*
2. **[me+you] First real scan + precision gate.** Point the backend at your real Slack+Gmail,
   `POST /scan`, label results true/false in-app, and measure **firm-bucket precision**. Tune the
   gate/prompt until ≥ ~80%. This is the original Phase-0 gate — do it before trusting nudges.
3. **[me] Harden the live adapters.** `SlackSource`/`GmailSource` are only fake-tested today; the
   first live run will expose real-shape bugs (pagination, MIME parts, weird dates). Add
   recorded-fixture contract tests as we find them.

### B. Onto the actual iPhone 17 Pro
4. **[done] API auth.** `LOOPKEEPER_API_TOKEN` — when set, app routes require
   `Authorization: Bearer <token>` (set in the app's Settings); `/healthz` + `/auth/*` stay open.
5. **[me] Device entitlements + ATS.** Add the Push Notifications capability (`aps-environment`) to
   `project.yml` and an ATS exception for your backend host (plain-http LAN/tunnel).
6. **[you] Install on device.** Free Apple ID signs 7-day builds (or paid for TestFlight); set the
   backend URL in Settings to your Mac's LAN IP / Tailscale; trust the dev cert on the phone.
7. **[me] APNs wiring end-to-end** once you have a `.p8` (`APNS_*` envs) — real nudges on device.

### C. Always-on (so nudges fire when the Mac sleeps)
8. **[me] Run the backend as a service** — a `launchd` plist for the Mac, or a one-click deploy to
   Fly.io/Render. Without this the scheduler only runs while `pnpm dev` is open.

---

## Make it feel finished — **[me]**, no credentials needed (good to do in parallel with A)
- **App icon + launch screen** (looks real in the simulator and on-device).
- **Onboarding / connect-accounts flow** + friendlier states: Scan button → "Connect Slack & Gmail
  first" instead of a raw error; a real empty state.
- **Loop detail screen** — tap a row → full context + actions.
- **Surface the Phase-2 features in the UI** (the APIs exist, the screens don't): view/copy a
  **draft chaser**, and **confirm a closure candidate** (closed_candidate → closed).
- **Precision labelling UI** — a quick true/false toggle per loop to feed step A2.

---

## Phase 3 — new capabilities (from the approved plan) — **[me]**
- **Calendar/RSVP loops** — ingest Google Calendar; un-RSVP'd invites + "I'll be there" become loops.
- **Hinglish / casual / delegated-commitment tuning** — widen extraction, measure against A2 data.
- **Android** — later; the backend is unchanged, only a second client.

---

## Hardening / quality — **[me]**, ongoing
- **Measured ROI**, not vanity — count loops acted-on vs dismissed (from app interactions); expose a
  weekly number.
- **Token-cost telemetry** per scan; confirm the pre-LLM gate keeps it cheap at real volume.
- **Re-nudge policy** — currently a loop is nudged once; decide on escalation for still-overdue items.
- **Postgres migration** — only when you add a second user (single-user SQLite is correct for now).

---

## Environment note — running the simulator
This Mac's Xcode auto-updated to the **iOS 26.5 SDK**, but only the **iOS 26.4** simulator runtime
is installed, so `xcodebuild` can't build for the simulator until the matching platform is added:
```sh
xcodebuild -downloadPlatform iOS      # or: Xcode ▸ Settings ▸ Components ▸ iOS 26.5
```
After that, the run recipe in `README.md` works again (the app built + ran fine before the update).

## Recommended immediate move
Two parallel lanes:
- **You:** start **A1** (Slack + Google + Anthropic credentials) — it's the only thing blocking real data.
- **Me:** build **B4 (API auth)** + **C (icon, onboarding, draft/closure UI, labelling)** so the app
  is secure and feels finished by the time your creds are ready.

Then we meet at **A2 (live scan + precision gate)** and **B6 (install on your iPhone)**.
