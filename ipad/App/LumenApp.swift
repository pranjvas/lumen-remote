import SwiftUI

// Lumen for iPad: the Lumen server (server/, run by Node inside this app) and its web UI
// (web/) in one app. See ipad/README.md.

@main
struct LumenApp: App {
    @StateObject private var host = ServerHost()
    @Environment(\.scenePhase) private var scenePhase

    var body: some Scene {
        WindowGroup {
            RootView(host: host)
                .onAppear {
                    host.start()
                }
                .onChange(of: scenePhase) { phase in
                    if phase == .active {
                        host.becameActive()
                    }
                }
        }
    }
}

enum Palette {
    static let background = Color(red: 0.027, green: 0.031, blue: 0.039)
    static let amber = Color(red: 1.0, green: 0.706, blue: 0.329)
    static let text = Color(red: 0.914, green: 0.914, blue: 0.933)
    static let dim = Color(red: 0.604, green: 0.604, blue: 0.647)
}

struct RootView: View {
    @ObservedObject var host: ServerHost

    var body: some View {
        ZStack {
            Palette.background.ignoresSafeArea()
            content
        }
        .preferredColorScheme(.dark)
    }

    @ViewBuilder
    private var content: some View {
        switch host.phase {
        case .ready(let url):
            // The page sits below the status bar, as it does when Safari runs it from the Home
            // Screen (its tablet layout has no room for the status bar), and handles the other
            // edges and the keyboard itself.
            RemoteWebView(url: url)
                .ignoresSafeArea(.container, edges: [.horizontal, .bottom])
                .ignoresSafeArea(.keyboard)
        case .starting:
            StartingView(message: host.message)
        case .failed(let reason):
            FailedView(reason: reason, log: host.logTail)
        }
    }
}

struct StartingView: View {
    let message: String

    var body: some View {
        VStack(spacing: 18) {
            ProgressView()
                .progressViewStyle(.circular)
                .tint(Palette.amber)
                .scaleEffect(1.3)
            Text(message)
                .font(.callout)
                .foregroundColor(Palette.dim)
                .multilineTextAlignment(.center)
        }
        .padding(32)
    }
}

struct FailedView: View {
    let reason: String
    let log: String

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                Text("Lumen did not start")
                    .font(.title2.weight(.semibold))
                    .foregroundColor(Palette.text)
                Text(reason)
                    .font(.body)
                    .foregroundColor(Palette.text)
                Text("Close Lumen from the app switcher and open it again. If it keeps happening, the log below says why; the full logs are in the Files app under On My iPad, Lumen, data, logs.")
                    .font(.callout)
                    .foregroundColor(Palette.dim)
                if !log.isEmpty {
                    Text(log)
                        .font(.system(.footnote, design: .monospaced))
                        .foregroundColor(Palette.dim)
                        .textSelection(.enabled)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
            }
            .padding(24)
            .frame(maxWidth: 720, alignment: .leading)
        }
    }
}
