# SEPOS-IOS-001 — iPad app with direct thermal printing (build runbook)

Goal: the same Capacitor app that runs on Sunmi/Android, built for iPad, with
`sendRawToPrinter()` driving LAN ESC/POS printers natively — so a restaurant can
run **just an iPad + a thermal printer** (the £250 anti-Square package).

Written 2026-08-04 while Xcode's iOS platform downloaded, so the next session
starts at step 1 instead of re-deriving. Style copied from `node-host/BUILD.md`
(which saved the spike rebuild).

## State when this was written
- Xcode 26.6 installed; **iOS 26.5 platform component downloading** (only macOS +
  iOS ticked — watch/tv/vision deliberately skipped).
- `@capacitor/core|cli|android` **8.4.1** in `client/` — `@capacitor/ios` NOT yet
  installed; no `ios/` folder yet.
- `PrinterPlugin.swift` (this folder) is the finished iOS twin of
  `android/app/src/main/java/uk/co/siamepos/app/PrinterPlugin.java` — same
  `Printer.sendRaw({host, port, data, timeoutMs})` contract, so
  `client/src/native/printer.js` needs **zero changes**.
- No physical iPad — develop/verify on the **iPad Simulator** (shares the Mac's
  network, so it CAN print to a real LAN POS80).
- Apple Developer account exists (the one that notarizes the Mac desktop app).

## Build steps (next session)
1. Branch: `git worktree add ~/.siamepos-worktrees/ios-build -b ios-app android-app`
   (start from android-app — it carries the Capacitor project + native JS shims;
   merge `main` first for the freshest client).
2. `cd client && npm i @capacitor/ios@8` (match the 8.x line of core/cli).
3. `npm run build && npx cap add ios && npx cap sync ios`.
4. Register the plugin (Capacitor 8, app-embedded):
   - copy `ios-native/PrinterPlugin.swift` → `ios/App/App/PrinterPlugin.swift`
     and add it to the App target in Xcode (drag into the project navigator);
   - in `capacitor.config.json` add: `"packageClassList": ["PrinterPlugin"]`
     (this is how Cap 8 discovers in-app plugins on iOS; Android ignores it —
     it registers via MainActivity).
5. **Info.plist additions (`ios/App/App/Info.plist`) — WITHOUT THESE PRINTING
   SILENTLY FAILS on iOS 14+:**
   ```xml
   <key>NSLocalNetworkUsageDescription</key>
   <string>SiamEPOS connects to your receipt and kitchen printers on this network.</string>
   ```
   (Raw TCP to LAN triggers the one-time "find devices on your local network"
   permission prompt; if the user declines, every connect fails with a vague
   route/timeout error — check Settings → Privacy → Local Network when
   debugging "printer unreachable on iPad but fine elsewhere".)
6. CocoaPods: not installed on this Mac. Capacitor 8 default is **SPM**
   (`npx cap add ios` scaffolds Swift-Package-Manager projects) — pods likely
   unnecessary; if the scaffold demands pods anyway: `brew install cocoapods`.
7. Open `ios/App/App.xcworkspace` (or `.xcodeproj` for SPM) in Xcode →
   Signing & Capabilities → select the team (same Apple account as
   notarization) → run on an **iPad Simulator**.
8. In the simulated app: Setup screen → point at a cloud tenant (e.g. the demo
   `https://baan-siam.siamepos.co.uk`) exactly like an Android satellite.

## Print test (no iPad needed)
- Put a POS80-family printer on the same Wi-Fi as this Mac (static IP as usual).
- In the simulated app: Admin → Printers → set the IP → **Test** — the ESC/POS
  buffer comes from the server (`/api/print/buffers/...`), the plugin fires it
  over TCP. A real slip printing out of a real printer from a fake iPad = proof.
- Also test failure paths: wrong IP (expect the loud toast, not silence) and
  the Local Network permission denied case (reset via Settings in the sim).

## Distribution (after it works)
- **TestFlight**: App Store Connect → create the app record (bundle id
  `uk.co.siamepos.app` — NOTE: same as Android appId; iOS bundle ids are a
  separate namespace, fine) → archive + upload from Xcode → internal testers
  install on any iPad, no cable. 1–2 days including Apple processing.
- **App Store** proper (for clients at scale): review lead time ~1 week; POS
  apps are routine approvals.

## Known non-blockers
- `SunmiPrinterPlugin` is Android-only — on iOS the `registerPlugin` proxy just
  rejects if ever called; the printer.js paths that matter for iPad are the
  network `Printer` plugin + server-side printing. Verify no unguarded Sunmi
  call sits in the iPad flow during testing.
- The desktop-only guards (`window.siamepos?.isElectron`) are false on iOS —
  the app behaves as a native satellite, same as Android cloud mode.
