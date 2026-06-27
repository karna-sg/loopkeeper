# Loopkeeper iOS (Phase 1)

Native SwiftUI app — the surface for the open-loops backend. Built in Phase 1 once the
Phase-0 extraction precision gate (≥ ~80% firm-bucket precision) is cleared.

Planned shape:
- `ASWebAuthenticationSession` OAuth handoff to the backend (the app never holds Slack/Google secrets).
- Unified list: **Overdue / Due today / This week / Awaiting others**, each loop showing summary,
  counterpart, channel badge, due date, and a deep-link to the source thread/email.
- Actions: Open source · Snooze · Mark done · Dismiss (each doubles as the precision signal).
- `UserNotifications` + APNs nudges with Snooze/Done actions; `BackgroundTasks` refresh.
- `SwiftData` local cache of the signed-in user's own loops only.
- Settings: per-source tenant allowlist, quote-excerpt toggle, nudge timing, retention, delete-my-data.

## Target device

Primary device: **iPhone 17 Pro** (iOS 26). Built with **Swift 6 / Xcode 26.4** (already installed
on the Mac). Deployment target iOS 18 so older devices still run it.

## Generate & build

The Xcode project is generated from `project.yml` (so it's reproducible and not committed):

```sh
brew install xcodegen          # one-time
cd ios && xcodegen generate    # writes Loopkeeper.xcodeproj
open Loopkeeper.xcodeproj       # then ⌘R on an iPhone 17 Pro simulator
# or headless:
xcodebuild -project Loopkeeper.xcodeproj -scheme Loopkeeper \
  -destination 'platform=iOS Simulator,name=iPhone 17 Pro' build
```

Sources (`Sources/`): `Models.swift` (Codable mirror of the API), `APIClient.swift`
(async REST client + backend URL config), `AppModel.swift` (`@Observable` state),
`ContentView.swift` (sectioned list + swipe Done/Snooze/Dismiss), `SettingsView.swift`
(backend URL + connect links), `LoopkeeperApp.swift` (entry). Set the backend URL in Settings.

## How you'll test on the MacBook (Phase 1)

Two layers, both driven from the Mac:

1. **Backend (testable today)** — runs locally on the Mac. `pnpm --filter @loopkeeper/backend test`
   for unit tests; later `pnpm dev` starts the HTTP server on `localhost:8787` and you hit it with
   `curl`/Bunch. No device needed.
2. **iOS app (once scaffolded)**
   - **iOS Simulator** (fastest loop): open `ios/Loopkeeper.xcodeproj` in Xcode → pick an
     *iPhone 17 Pro* simulator → ⌘R. Simulated push works by dropping a `.apns` file on the
     simulator; *real* APNs requires a physical device.
   - **Your iPhone 17 Pro** (real push + real feel): plug in over USB (or Wi-Fi pairing) → select it
     as the run destination → ⌘R installs the dev build directly. A **free Apple ID** signs builds
     that last 7 days; a **paid Apple Developer account** unlocks TestFlight + long-lived builds.
   - **Phone → Mac backend reachability**: the phone can't see `localhost`. Use the Mac's LAN IP, a
     **Tailscale** tailnet, or an `ngrok`/`cloudflared` tunnel to point the app at the local backend —
     or deploy the backend to a small host (Fly.io/Render) for always-on testing.

A full test loop will be: run backend on Mac → run app on the iPhone 17 Pro pointed at it → connect
Slack+Gmail → a real loop appears in the list → an APNs nudge fires before its due date → snooze/done
round-trips to the backend.
