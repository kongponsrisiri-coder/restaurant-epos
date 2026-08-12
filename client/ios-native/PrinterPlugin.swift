// SEPOS-IOS-001 — raw ESC/POS network printing (iOS twin of PrinterPlugin.java).
//
// Same contract as Android so client/src/native/printer.js works unchanged:
//   Printer.sendRaw({ host, port = 9100, data = <base64 ESC/POS>, timeoutMs = 6000 })
//     → resolves { ok: true, bytes: N }
//     → rejects  "host and data (base64) are required" | "data is not valid base64"
//                | "print failed: <reason>"
//
// Uses Network.framework (NWConnection) — raw TCP is NOT subject to App
// Transport Security, but iOS 14+ DOES require the Local Network permission:
// Info.plist needs NSLocalNetworkUsageDescription (see BUILD-IOS.md) and the
// user must accept the one-time "wants to find devices on your network" prompt
// — without it every connect fails with "No route to host"-style errors.
//
// Capacitor 8: register by adding "PrinterPlugin" to packageClassList in
// capacitor.config (BUILD-IOS.md step 4).

import Foundation
import Capacitor
import Network

@objc(PrinterPlugin)
public class PrinterPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "PrinterPlugin"
    public let jsName = "Printer"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "sendRaw", returnType: CAPPluginReturnPromise)
    ]

    @objc func sendRaw(_ call: CAPPluginCall) {
        guard let host = call.getString("host"),
              let dataB64 = call.getString("data") else {
            call.reject("host and data (base64) are required")
            return
        }
        let port = call.getInt("port") ?? 9100
        let timeoutMs = call.getInt("timeoutMs") ?? 6000

        guard let bytes = Data(base64Encoded: dataB64, options: [.ignoreUnknownCharacters]) else {
            call.reject("data is not valid base64")
            return
        }
        guard let nwPort = NWEndpoint.Port(rawValue: UInt16(clamping: port)) else {
            call.reject("print failed: invalid port \(port)")
            return
        }

        let connection = NWConnection(
            host: NWEndpoint.Host(host),
            port: nwPort,
            using: .tcp
        )

        // One-shot completion guard — timeout, failure and success all race.
        let done = NSLock()
        var finished = false
        func finish(_ block: () -> Void) {
            done.lock(); defer { done.unlock() }
            if finished { return }
            finished = true
            block()
            connection.cancel()
        }

        let queue = DispatchQueue(label: "uk.co.siamepos.printer")

        // Connect timeout (NWConnection has no built-in one).
        queue.asyncAfter(deadline: .now() + .milliseconds(timeoutMs)) {
            finish { call.reject("print failed: timeout after \(timeoutMs)ms") }
        }

        connection.stateUpdateHandler = { state in
            switch state {
            case .ready:
                connection.send(content: bytes, completion: .contentProcessed { error in
                    if let error = error {
                        finish { call.reject("print failed: \(error.localizedDescription)") }
                        return
                    }
                    // Give the printer's TCP stack a beat to drain before we
                    // cancel — mirrors the Android flush-then-close behaviour.
                    queue.asyncAfter(deadline: .now() + .milliseconds(150)) {
                        finish {
                            var ret = JSObject()
                            ret["ok"] = true
                            ret["bytes"] = bytes.count
                            call.resolve(ret)
                        }
                    }
                })
            case .failed(let error):
                finish { call.reject("print failed: \(error.localizedDescription)") }
            case .waiting(let error):
                // Unreachable host sits in .waiting forever — treat as failure
                // (the POS80s are static-IP LAN peers; waiting means wrong IP,
                // printer off, or the Local Network permission was denied).
                finish { call.reject("print failed: \(error.localizedDescription)") }
            default:
                break
            }
        }

        connection.start(queue: queue)
    }
}
