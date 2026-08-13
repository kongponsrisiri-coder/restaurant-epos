// SEPOS-IOS-HOST-001 — embedded Node.js host for iPad (iOS twin of
// NodeHostPlugin.java). Runs the REAL SiamEPOS backend inside the app via
// NodeMobile.xcframework (nodejs-mobile v18.20.4 — same runtime version as the
// Android host), so an iPad can be the LAN host till: satellites + printers
// talk to http://<ipad-ip>:3001.
//
// Same JS contract as Android so client/src/native/nodeHost.js works
// unchanged: start / stop / status / getLanIp / lastCrash / lastLog /
// saveConfig / requestIgnoreBatteryOptimizations.
//
// iOS-specific design (vs the Android plugin):
//  * NO extraction step. Android copies nodejs-project into filesDir and wipes
//    it per start; here node runs main.js STRAIGHT FROM THE APP BUNDLE
//    (read-only is fine — main.js picks its writable dir from
//    NODE_HOST_DATA_DIR, which we point at Documents/node-host-data). Keeping
//    node_modules inside the signed bundle also keeps dlopen of the .node
//    native addons happy with iOS code-signing.
//  * host-config.json lives at Documents/host-config.json — the parent of
//    NODE_HOST_DATA_DIR, exactly where main.js's loadHostConfig() looks first.
//  * node_start() can only run ONCE per process (libnode has no clean
//    in-process restart) — `stop` is honest about that: quit the app to stop.
//  * While hosting, the screen is kept awake (isIdleTimerDisabled) — the host
//    must never doze mid-service; plug the iPad in and it runs all day.

import Foundation
import Capacitor
import NodeMobile
import Network
import UIKit

@objc(NodeHostPlugin)
public class NodeHostPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "NodeHostPlugin"
    public let jsName = "NodeHost"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "start", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "stop", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "status", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "getLanIp", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "lastCrash", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "lastLog", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "saveConfig", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "requestIgnoreBatteryOptimizations", returnType: CAPPluginReturnPromise),
    ]

    static let PORT = 3001
    // node_start is once-per-process — track it process-wide, not per-instance.
    static var started = false
    static var startupError: String? = nil

    private var documentsDir: URL {
        FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
    }
    private var dataDir: URL { documentsDir.appendingPathComponent("node-host-data") }
    private var configFile: URL { documentsDir.appendingPathComponent("host-config.json") }

    // ── start ─────────────────────────────────────────────────────────
    // Shared engine start — called by the JS plugin method AND by the
    // `--start-host` launch argument (AppDelegate), which lets the dev Mac
    // start the host via devicectl for hands-free on-device verification.
    // iOS 14+ gates INBOUND connections to our listener behind the Local
    // Network permission — and the system only raises the consent prompt when
    // the app itself attempts a local-network operation (quietly listening
    // never triggers it; satellites just get dropped with no dialog anywhere).
    // So the host knocks first: one fire-and-forget UDP dgram to the LAN
    // broadcast at start. The prompt then appears at SETUP time, where the
    // operator expects a question — not mid-service when till #2 tries to join.
    static func primeLocalNetworkPermission() {
        let conn = NWConnection(host: "255.255.255.255", port: 3001, using: .udp)
        conn.stateUpdateHandler = { _ in }
        conn.start(queue: .global())
        conn.send(content: "siamepos-host-hello".data(using: .utf8),
                  completion: .contentProcessed { _ in conn.cancel() })
    }

    @discardableResult
    static func startEngine() -> [String: Any] {
        if started { return ["started": true, "port": PORT, "alreadyRunning": true] }
        primeLocalNetworkPermission()
        let docs = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
        let data = docs.appendingPathComponent("node-host-data")
        guard let projectDir = Bundle.main.url(forResource: "nodejs-project", withExtension: nil),
              FileManager.default.fileExists(atPath: projectDir.appendingPathComponent("main.js").path) else {
            startupError = "nodejs-project not found in app bundle"
            return ["started": false, "error": startupError as Any]
        }
        do {
            try FileManager.default.createDirectory(at: data, withIntermediateDirectories: true)
        } catch {
            startupError = "cannot create data dir: \(error.localizedDescription)"
            return ["started": false, "error": startupError as Any]
        }

        // main.js contract (same as Android): writable dir via env, config in
        // its parent, cwd = the project dir so relative requires resolve.
        setenv("NODE_HOST_DATA_DIR", data.path, 1)
        FileManager.default.changeCurrentDirectoryPath(projectDir.path)

        let mainJs = projectDir.appendingPathComponent("main.js").path
        started = true
        startupError = nil

        Thread.detachNewThread {
            Thread.current.name = "siamepos-node-host"
            Thread.current.stackSize = 4 * 1024 * 1024
            // argv must outlive node_start — build stable C strings.
            let args = ["node", mainJs]
            var cargs: [UnsafeMutablePointer<CChar>?] = args.map { strdup($0) }
            defer { cargs.forEach { free($0) } }
            _ = node_start(Int32(args.count), &cargs)
            // node_start returning at all means the runtime ended.
            started = false
        }

        // The host must not doze mid-service — keep the screen awake while
        // hosting (the operator plugs the iPad in; this is the kiosk posture).
        DispatchQueue.main.async { UIApplication.shared.isIdleTimerDisabled = true }

        return ["started": true, "port": PORT]
    }

    @objc func start(_ call: CAPPluginCall) {
        call.resolve(NodeHostPlugin.startEngine())
    }

    // ── stop ──────────────────────────────────────────────────────────
    @objc func stop(_ call: CAPPluginCall) {
        // libnode cannot be cleanly restarted in-process on iOS. Be honest —
        // the UI shows this message on the host card.
        call.resolve([
            "started": NodeHostPlugin.started,
            "error": "On iPad, close the app to stop the host (the server can't be stopped while the app runs).",
        ])
    }

    // ── status ────────────────────────────────────────────────────────
    @objc func status(_ call: CAPPluginCall) {
        var ret: [String: Any] = [
            "started": NodeHostPlugin.started,
            "fallbackPort": NodeHostPlugin.PORT,
            "abi": "ios-arm64",
            "nativeReady": true,
            "sqlite": false,  // authoritative value merged JS-side from /api/ping
        ]
        ret["port"] = NodeHostPlugin.started ? NodeHostPlugin.PORT : nil
        ret["error"] = NodeHostPlugin.startupError
        call.resolve(ret)
    }

    // ── getLanIp ──────────────────────────────────────────────────────
    // First site-local IPv4 on en0 (Wi-Fi), then any other interface — same
    // preference order as Android's Wi-Fi-lease-then-enumerate.
    @objc func getLanIp(_ call: CAPPluginCall) {
        var wifi: String? = nil
        var other: String? = nil
        var ifaddr: UnsafeMutablePointer<ifaddrs>? = nil
        if getifaddrs(&ifaddr) == 0 {
            var ptr = ifaddr
            while let p = ptr {
                let ifa = p.pointee
                if let sa = ifa.ifa_addr, sa.pointee.sa_family == UInt8(AF_INET),
                   (ifa.ifa_flags & UInt32(IFF_LOOPBACK)) == 0 {
                    var addr = sa.withMemoryRebound(to: sockaddr_in.self, capacity: 1) { $0.pointee.sin_addr }
                    var buf = [CChar](repeating: 0, count: Int(INET_ADDRSTRLEN))
                    if inet_ntop(AF_INET, &addr, &buf, socklen_t(INET_ADDRSTRLEN)) != nil {
                        let ip = String(cString: buf)
                        let name = String(cString: ifa.ifa_name)
                        if name == "en0" { wifi = wifi ?? ip } else { other = other ?? ip }
                    }
                }
                ptr = ifa.ifa_next
            }
            freeifaddrs(ifaddr)
        }
        call.resolve(["ip": (wifi ?? other) as Any, "port": NodeHostPlugin.PORT])
    }

    // ── lastCrash ─────────────────────────────────────────────────────
    // No native crash-handler file on iOS yet (Android writes one from C++).
    @objc func lastCrash(_ call: CAPPluginCall) {
        call.resolve(["crash": NSNull()])
    }

    // ── lastLog ───────────────────────────────────────────────────────
    // main.js writes its breadcrumb log to <NODE_HOST_DATA_DIR>/node-host-log.txt.
    @objc func lastLog(_ call: CAPPluginCall) {
        let logFile = dataDir.appendingPathComponent("node-host-log.txt")
        let contents = (try? String(contentsOf: logFile, encoding: .utf8))
        call.resolve(["log": (contents?.isEmpty == false ? contents : nil) as Any])
    }

    // ── saveConfig ────────────────────────────────────────────────────
    // Merge-write Documents/host-config.json (absent keys PRESERVE existing
    // values, same as Android). Secrets stay in app-private storage.
    @objc func saveConfig(_ call: CAPPluginCall) {
        var cfg: [String: Any] = [:]
        if let data = try? Data(contentsOf: configFile),
           let existing = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
            cfg = existing
        }
        for key in ["cloud_sync_enabled", "cloud_api_url", "restaurant_id", "sync_secret", "restaurant_name"] {
            if let v = call.getString(key) { cfg[key] = v }
        }
        do {
            let out = try JSONSerialization.data(withJSONObject: cfg, options: [.prettyPrinted, .sortedKeys])
            try out.write(to: configFile, options: .atomic)
            call.resolve(["saved": true])
        } catch {
            call.resolve(["saved": false, "error": "write failed: \(error.localizedDescription)"])
        }
    }

    // ── requestIgnoreBatteryOptimizations ─────────────────────────────
    // Android-only concept; on iOS the kiosk posture (idle-timer off + power)
    // is the equivalent. No-op success so shared JS never branches.
    @objc func requestIgnoreBatteryOptimizations(_ call: CAPPluginCall) {
        call.resolve(["ok": true, "ios": true])
    }
}
