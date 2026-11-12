import Foundation
import SwiftUI
import UIKit

// Owns the Lumen server that runs inside this app: prepares the data folder, starts Node,
// waits for the server to report that it is up, and applies the two settings from the
// Settings app (keep the screen on, keep running in the background).
//
// Node is started once and never again. When iPadOS suspends the app, Node rebuilds the server
// by itself on return (server/embedded-host.js); this side waits for that and reloads the page.
@MainActor
final class ServerHost: ObservableObject {
    enum Phase: Equatable {
        case starting
        case ready(URL)
        case failed(String)
    }

    @Published private(set) var phase: Phase = .starting
    @Published private(set) var message = "Starting Lumen"
    @Published private(set) var logTail = ""
    /// Goes up when the page should be loaded again, because the server behind it was rebuilt.
    @Published private(set) var reloadToken = 0

    private var started = false
    private var checkingServer = false
    private var pageGeneration = 0
    private let keepAlive = BackgroundKeepAlive()
    private let defaults = UserDefaults.standard

    private let dataDir: URL
    private let logsDir: URL
    private let statusFile: URL
    private let controlFile: URL
    private let consoleLog: URL

    init() {
        let documents = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
        dataDir = documents.appendingPathComponent("data", isDirectory: true)
        logsDir = dataDir.appendingPathComponent("logs", isDirectory: true)
        statusFile = dataDir.appendingPathComponent("host-status.json")
        controlFile = dataDir.appendingPathComponent("host-control.json")
        consoleLog = logsDir.appendingPathComponent("node-console.log")
        defaults.register(defaults: ["run_in_background": false, "keep_awake": true])
    }

    func start() {
        if started { return }
        started = true
        applySettings()

        let files = FileManager.default
        do {
            try files.createDirectory(at: logsDir, withIntermediateDirectories: true)
        } catch {
            phase = .failed("Lumen could not create its data folder: " + error.localizedDescription)
            return
        }
        // The server writes this file when it is up; an old one would be mistaken for a new start.
        try? files.removeItem(at: statusFile)
        writeGuideIfMissing()
        redirectConsole()

        let script = Bundle.main.bundlePath + "/nodejs-project/server/embedded.js"
        guard files.fileExists(atPath: script) else {
            phase = .failed("The server files are missing from this build of the app.")
            return
        }

        setenv("LUMEN_DATA_DIR", dataDir.path, 1)
        let key = (defaults.string(forKey: "anthropic_api_key") ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        if !key.isEmpty {
            setenv("ANTHROPIC_API_KEY", key, 1)
        }

        let thread = Thread { [weak self] in
            let code = NodeRunner.run(arguments: ["node", script])
            Task { @MainActor in
                self?.nodeExited(code)
            }
        }
        thread.name = "lumen-node"
        thread.stackSize = 4 * 1024 * 1024
        thread.qualityOfService = .userInitiated
        thread.start()

        Task {
            await waitForServer()
        }
    }

    // Called when the app comes back on screen. The settings may have changed meanwhile, and if
    // iPadOS suspended the app, Node is rebuilding the server right now or is about to.
    func becameActive() {
        applySettings()
        guard case .ready(let url) = phase, !checkingServer else { return }
        checkingServer = true
        Task {
            let alive = await recover(url)
            checkingServer = false
            guard case .ready = phase else { return }
            if alive {
                let generation = readStatus()?["generation"] as? Int ?? pageGeneration
                if generation != pageGeneration {
                    pageGeneration = generation
                    reloadToken += 1
                }
            } else {
                logTail = recentLog()
                phase = .failed("Lumen's server did not come back after iPadOS paused the app.")
            }
        }
    }

    // Waits until the server answers twice in a row, so that a restart which is only just
    // beginning is not mistaken for a healthy server. If nothing answers for a while, asks Node
    // for a restart through host-control.json (server/embedded-host.js reads it).
    private func recover(_ base: URL) async -> Bool {
        let began = Date()
        var asked = false
        var steady = 0
        while Date().timeIntervalSince(began) < 45 {
            let ready = (readStatus()?["state"] as? String) == "ready"
            let answered = ready ? await serverAnswers(base) : false
            if answered {
                steady += 1
                if steady >= 2 { return true }
            } else {
                steady = 0
                if !asked && Date().timeIntervalSince(began) > 8 {
                    asked = true
                    askForRestart()
                }
            }
            try? await Task.sleep(nanoseconds: 1_200_000_000)
        }
        return false
    }

    private func serverAnswers(_ base: URL) async -> Bool {
        var request = URLRequest(url: base.appendingPathComponent("api/health"))
        request.timeoutInterval = 2
        request.cachePolicy = .reloadIgnoringLocalCacheData
        guard let result = try? await URLSession.shared.data(for: request) else { return false }
        return (result.1 as? HTTPURLResponse)?.statusCode == 200
    }

    private func askForRestart() {
        let text = "{\"restart\":\"" + UUID().uuidString + "\"}"
        try? text.write(to: controlFile, atomically: true, encoding: .utf8)
    }

    private func applySettings() {
        UIApplication.shared.isIdleTimerDisabled = defaults.bool(forKey: "keep_awake")
        if defaults.bool(forKey: "run_in_background") {
            keepAlive.start()
        } else {
            keepAlive.stop()
        }
    }

    private func waitForServer() async {
        let began = Date()
        while true {
            if case .failed = phase { return }

            if let status = readStatus() {
                let state = status["state"] as? String ?? ""
                if state == "ready", let port = status["httpPort"] as? Int, let url = URL(string: "http://127.0.0.1:\(port)/") {
                    pageGeneration = status["generation"] as? Int ?? 1
                    phase = .ready(url)
                    return
                }
                if state == "failed" {
                    logTail = recentLog()
                    phase = .failed(explain(status))
                    return
                }
            }

            let waited = Date().timeIntervalSince(began)
            if waited > 90 {
                logTail = recentLog()
                phase = .failed("The server did not start within 90 seconds.")
                return
            }
            if waited > 6 {
                message = "Still starting. The first launch takes the longest."
            }
            try? await Task.sleep(nanoseconds: 300_000_000)
        }
    }

    private func nodeExited(_ code: Int32) {
        logTail = recentLog()
        // A start that failed leaves its reason in the status file; Node then simply runs out of work.
        if let status = readStatus(), status["state"] as? String == "failed" {
            phase = .failed(explain(status))
        } else {
            phase = .failed("The server stopped (code \(code)).")
        }
    }

    private func readStatus() -> [String: Any]? {
        guard let data = try? Data(contentsOf: statusFile) else { return nil }
        guard let object = try? JSONSerialization.jsonObject(with: data) else { return nil }
        return object as? [String: Any]
    }

    private func explain(_ status: [String: Any]) -> String {
        if status["code"] as? String == "EADDRINUSE" {
            return "Another copy of Lumen is already using its port on this iPad."
        }
        let reason = status["error"] as? String ?? "unknown reason"
        return "The server could not start: " + reason
    }

    private func recentLog() -> String {
        var parts: [String] = []
        for file in [consoleLog, logsDir.appendingPathComponent("lumen.log")] {
            guard let text = try? String(contentsOf: file, encoding: .utf8), !text.isEmpty else { continue }
            parts.append(file.lastPathComponent + "\n" + String(text.suffix(2500)))
        }
        return parts.joined(separator: "\n\n")
    }

    // Node writes to the process's standard output and error, which nobody can see on an iPad:
    // send both to a file in the data folder instead.
    private func redirectConsole() {
        let files = FileManager.default
        if let attributes = try? files.attributesOfItem(atPath: consoleLog.path),
           let size = attributes[.size] as? NSNumber,
           size.intValue > 512 * 1024 {
            try? files.removeItem(at: consoleLog)
        }
        _ = freopen(consoleLog.path, "a", stdout)
        _ = freopen(consoleLog.path, "a", stderr)
        setvbuf(stdout, nil, _IOLBF, 0)
        setvbuf(stderr, nil, _IONBF, 0)
    }

    private func writeGuideIfMissing() {
        let guide = dataDir.appendingPathComponent("READ ME.txt")
        if FileManager.default.fileExists(atPath: guide.path) { return }
        let text = """
        Lumen keeps everything it knows in this folder.

        To move Lumen from a PC to this iPad, copy these files from the PC's
        lumen-remote/data folder into this folder, then close and reopen Lumen:

          secrets.json     the key the apps on the TV use to reach Lumen
          tv.json          the remote-control pairing
          ipcontrol.json   the picture and sound settings pairing
          config.json      your settings (the TV's address is tv.host)

        The apps on the TV (Lumen Agent, Lumen Eyes) call the address of the PC
        they were built for. Give this iPad that same address on your Wi-Fi
        (Settings > Wi-Fi > your network > Configure IP > Manual), or rebuild
        the TV apps for the iPad's address.

        Logs are in the logs folder.
        """
        try? text.write(to: guide, atomically: true, encoding: .utf8)
    }
}
