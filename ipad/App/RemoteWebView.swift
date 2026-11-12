import SwiftUI
import UIKit
import WebKit

// The Lumen web UI, loaded from the server inside this app (http://127.0.0.1:<port>).
struct RemoteWebView: UIViewRepresentable {
    let url: URL

    func makeCoordinator() -> Coordinator {
        Coordinator(home: url)
    }

    func makeUIView(context: Context) -> WKWebView {
        let configuration = WKWebViewConfiguration()
        configuration.allowsInlineMediaPlayback = true
        configuration.applicationNameForUserAgent = "LumenApp"

        let webView = WKWebView(frame: .zero, configuration: configuration)
        webView.navigationDelegate = context.coordinator
        webView.uiDelegate = context.coordinator
        webView.isOpaque = false
        webView.backgroundColor = UIColor(red: 0.027, green: 0.031, blue: 0.039, alpha: 1)
        webView.scrollView.backgroundColor = UIColor(red: 0.027, green: 0.031, blue: 0.039, alpha: 1)
        // The page lays itself out around the notch and home indicator (viewport-fit=cover).
        webView.scrollView.contentInsetAdjustmentBehavior = .never
        webView.scrollView.bounces = false
        webView.allowsLinkPreview = false
        if #available(iOS 16.4, *) {
            webView.isInspectable = true
        }
        webView.load(URLRequest(url: url))
        return webView
    }

    func updateUIView(_ webView: WKWebView, context: Context) {}

    final class Coordinator: NSObject, WKNavigationDelegate, WKUIDelegate {
        private let home: URL
        private var retries = 0

        init(home: URL) {
            self.home = home
        }

        private func isLumen(_ target: URL) -> Bool {
            target.host == home.host && target.port == home.port
        }

        // Lumen's own pages stay here; any other link opens in Safari.
        func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
            guard let target = navigationAction.request.url else {
                decisionHandler(.allow)
                return
            }
            let scheme = (target.scheme ?? "").lowercased()
            let mainFrame = navigationAction.targetFrame?.isMainFrame ?? true
            if isLumen(target) || !mainFrame || scheme == "about" || scheme == "blob" || scheme == "data" {
                decisionHandler(.allow)
                return
            }
            if scheme == "http" || scheme == "https" {
                UIApplication.shared.open(target)
            }
            decisionHandler(.cancel)
        }

        // window.open and target="_blank".
        func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration, for navigationAction: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
            if let target = navigationAction.request.url {
                if isLumen(target) {
                    webView.load(navigationAction.request)
                } else {
                    UIApplication.shared.open(target)
                }
            }
            return nil
        }

        func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
            retries = 0
        }

        // The page can be asked for a moment before the server accepts connections: try again.
        func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
            guard retries < 20 else { return }
            retries += 1
            let request = URLRequest(url: home)
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) { [weak webView] in
                webView?.load(request)
            }
        }

        // iPadOS can end the page's process to free memory; load the page again.
        func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
            webView.load(URLRequest(url: home))
        }

        // The web UI asks for confirmation with confirm() in a few places (Connect TV agent).
        func webView(_ webView: WKWebView, runJavaScriptAlertPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping () -> Void) {
            let alert = UIAlertController(title: nil, message: message, preferredStyle: .alert)
            alert.addAction(UIAlertAction(title: "OK", style: .default) { _ in
                completionHandler()
            })
            show(alert, over: webView) {
                completionHandler()
            }
        }

        func webView(_ webView: WKWebView, runJavaScriptConfirmPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (Bool) -> Void) {
            let alert = UIAlertController(title: nil, message: message, preferredStyle: .alert)
            alert.addAction(UIAlertAction(title: "Cancel", style: .cancel) { _ in
                completionHandler(false)
            })
            alert.addAction(UIAlertAction(title: "OK", style: .default) { _ in
                completionHandler(true)
            })
            show(alert, over: webView) {
                completionHandler(false)
            }
        }

        // `unavailable` runs when there is nothing to present from, so the page is never left waiting.
        private func show(_ alert: UIAlertController, over webView: WKWebView, unavailable: () -> Void) {
            var presenter = webView.window?.rootViewController
            while let next = presenter?.presentedViewController {
                presenter = next
            }
            guard let presenter = presenter else {
                unavailable()
                return
            }
            presenter.present(alert, animated: true)
        }
    }
}
