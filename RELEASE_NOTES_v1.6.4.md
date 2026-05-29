# SiamEPOS Pro — v1.6.4

**For:** SiamEPOS team + restaurant operators
**Date:** 29 May 2026
**Previous release:** v1.6.3 (28 May)
**This is the first SIGNED + NOTARIZED build.** Downloads from GitHub Releases now open cleanly on any Mac — no Gatekeeper warning, no `right-click → Open`, no `xattr` terminal command.

---

## TL;DR

Apple Developer ID enrollment for SiamEPOS Ltd was approved 29 May. This release wires the build pipeline to sign and notarize every Mac DMG. Net result: new client onboarding becomes "download → drag to Applications → launch" with **zero friction**. No code changes — same features as v1.6.3.

---

## What's new

### SEPOS-NOTARIZE-001 — Apple Developer ID signing + notarization

- **Mac DMG signed** with the Developer ID Application certificate for SiamEPOS LTD (Team ID `G6D63G9WVY`)
- **Notarized** through Apple's notary service via `notarytool` during the CI build (`electron-builder` auto-detects the `APPLE_ID` / `APPLE_APP_SPECIFIC_PASSWORD` / `APPLE_TEAM_ID` env vars and runs the notarization step before producing the DMG)
- **Hardened runtime enabled** with the minimum set of entitlements Electron 33 needs to run under notarization (JIT, dyld env vars, library validation disabled for native modules, print + network for receipt printing)
- **Auto-update** still works — existing v1.6.x installs pull v1.6.4 silently on next restart, and now do so without any Gatekeeper interruption

### What this changes for clients

| Before v1.6.4 | After v1.6.4 |
|---|---|
| Double-click DMG → "developer cannot be verified" | Double-click DMG → opens cleanly |
| Operator has to right-click → Open OR run `xattr -dr com.apple.quarantine ...` | No workaround needed |
| Auto-update sometimes triggered Gatekeeper popups on existing installs | Auto-update is silent + signature-verified |
| Nong's onboarding script: "If you see a warning, right-click and click Open" | Nong's onboarding script: "Drag SiamEPOS to Applications and launch" |

---

## Build pipeline changes

`electron/package.json` `build.mac` block:
- `identity: null` — electron-builder picks the right Developer ID cert from the keychain automatically (no hardcoding)
- `hardenedRuntime: true`
- `gatekeeperAssess: false` (we run `spctl` in CI separately)
- `entitlements: entitlements.mac.plist`

`electron/entitlements.mac.plist` (new):
- 7 keys — the minimum set Electron 33 needs to launch under hardened runtime. Without these, the notarized app crashes at first launch with cryptic `CryptoTokenKit` / `EXC_BAD_ACCESS` errors.

`.github/workflows/release.yml`:
- New conditional `Import Apple Developer ID certificate` step — runs only when `MAC_CERT_P12_BASE64` secret is present (so unsigned-test builds still work if secrets ever rotate)
- 5 env vars passed to `npm run build:mac`: `CSC_LINK`, `CSC_KEY_PASSWORD`, `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID`

The 5 GitHub Actions secrets that flip on signing + notarization:
- `MAC_CERT_P12_BASE64` — base64 of the Developer ID Application `.p12`
- `MAC_CERT_PASSWORD` — the .p12 password
- `MAC_APPLE_ID` — Apple ID tied to the developer membership
- `MAC_APPLE_APP_PASSWORD` — app-specific password (rotateable at appleid.apple.com)
- `MAC_TEAM_ID` — 10-character Team ID

---

## Operator action required

**Nothing.** Existing v1.6.x installs auto-update silently. New downloads from the GitHub Release page open cleanly.

For Nong / onboarding docs: remove any step that mentions `right-click → Open` or `xattr -dr com.apple.quarantine` — no longer needed on v1.6.4 and later.

---

## Compatibility

- **No app behaviour changes** — same features, same UI, same database, same printing path as v1.6.3.
- **Mac installs only.** Windows installs still rely on SmartScreen-bypass workarounds (SEPOS-NOTARIZE-002 is a future ticket — needs a separate $99/yr Windows code-signing cert).
- **Notarization is per-build.** Every release from v1.6.4 onwards is automatically notarized — no manual step.

---

## Tickets shipped in this release

- SEPOS-NOTARIZE-001 — Apple Developer ID signing + DMG notarization

Full commit log: `git log v1.6.3..v1.6.4`.

---

*🤖 Generated alongside the v1.6.4 build by Krit.*
