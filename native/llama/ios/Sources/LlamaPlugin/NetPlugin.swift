// Balimda — © 2026 Bandar Altariqi. All rights reserved.
// Licensed under the Balimda License (see LICENSE): non-commercial use only;
// keep the Balimda name and the "Balimda by Bandar Altariqi" credit; no rebranding.

import Capacitor
import Foundation

/**
 * Requests made with the iPhone's own network code instead of the web view,
 * for servers that refuse the web view's Origin (Hermes Agent does, unless
 * told otherwise). Same plugin name, methods and events as the Android
 * NetPlugin.java; see src/native-fetch.js for the JavaScript side.
 *
 * request({id, url, method, headers, body}) resolves with {status, headers}
 * when the answer starts; "net" events then bring {id, data} (base64) and
 * finally {id, done: true} or {id, error}. cancel({id}) stops a request.
 */
@objc(NetPlugin)
public class NetPlugin: CAPPlugin, CAPBridgedPlugin, URLSessionDataDelegate {
    public let identifier = "NetPlugin"
    public let jsName = "Net"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "request", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "cancel", returnType: CAPPluginReturnPromise)
    ]

    private struct Running {
        let id: String
        var call: CAPPluginCall?  // until the answer starts
        var cancelled = false
    }

    // Everything below is only touched on `queue` (URLSession's delegate queue too).
    private let queue: OperationQueue = {
        let q = OperationQueue()
        q.maxConcurrentOperationCount = 1
        return q
    }()
    private var running: [Int: Running] = [:]      // task id -> request
    private var tasks: [String: URLSessionDataTask] = [:]

    private lazy var session: URLSession = {
        let config = URLSessionConfiguration.default
        config.requestCachePolicy = .reloadIgnoringLocalCacheData
        config.urlCache = nil
        // Agents can think for a while; Hermes sends a keepalive every few seconds.
        config.timeoutIntervalForRequest = 300
        config.waitsForConnectivity = false
        return URLSession(configuration: config, delegate: self, delegateQueue: queue)
    }()

    @objc func request(_ call: CAPPluginCall) {
        guard let id = call.getString("id"), let text = call.getString("url"), let url = URL(string: text),
              url.scheme == "http" || url.scheme == "https" else {
            call.reject("Only http and https addresses work.")
            return
        }
        var req = URLRequest(url: url)
        req.httpMethod = call.getString("method") ?? "GET"
        // Unpacking gzip can hold back a streamed reply.
        req.setValue("identity", forHTTPHeaderField: "Accept-Encoding")
        for (name, value) in call.getObject("headers") ?? [:] {
            if let v = value as? String { req.setValue(v, forHTTPHeaderField: name) }
        }
        if let body = call.getString("body") { req.httpBody = Data(body.utf8) }
        let request = req
        queue.addOperation {
            let task = self.session.dataTask(with: request)
            self.running[task.taskIdentifier] = Running(id: id, call: call)
            self.tasks[id] = task
            task.resume()
        }
    }

    @objc func cancel(_ call: CAPPluginCall) {
        let id = call.getString("id") ?? ""
        queue.addOperation {
            if let task = self.tasks[id] {
                self.running[task.taskIdentifier]?.cancelled = true
                task.cancel()
            }
        }
        call.resolve()
    }

    public func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive response: URLResponse,
                           completionHandler: @escaping (URLSession.ResponseDisposition) -> Void) {
        guard var r = running[dataTask.taskIdentifier], let http = response as? HTTPURLResponse else {
            completionHandler(.cancel)
            return
        }
        var headers: [String: String] = [:]
        for (name, value) in http.allHeaderFields {
            headers[String(describing: name).lowercased()] = String(describing: value)
        }
        r.call?.resolve(["status": http.statusCode, "headers": headers])
        r.call = nil
        running[dataTask.taskIdentifier] = r
        completionHandler(.allow)
    }

    public func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) {
        guard let r = running[dataTask.taskIdentifier], !r.cancelled else { return }
        notifyListeners("net", data: ["id": r.id, "data": data.base64EncodedString()])
    }

    public func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        guard let r = running.removeValue(forKey: task.taskIdentifier) else { return }
        tasks.removeValue(forKey: r.id)
        let message = r.cancelled ? "Cancelled" : error.map { describe($0, task.originalRequest?.url) }
        if let call = r.call {
            call.reject(message ?? "The server closed the connection without answering.")
        } else if let message = message {
            notifyListeners("net", data: ["id": r.id, "error": message])
        } else {
            notifyListeners("net", data: ["id": r.id, "done": true])
        }
    }

    // Says what went wrong in words a person can act on.
    private func describe(_ error: Error, _ url: URL?) -> String {
        let at = url.flatMap { u in u.host.map { " at \($0)\(u.port.map { ":\($0)" } ?? "")" } } ?? ""
        let e = error as NSError
        guard e.domain == NSURLErrorDomain else { return error.localizedDescription }
        switch e.code {
        case NSURLErrorCannotFindHost, NSURLErrorDNSLookupFailed:
            return "Couldn't find the server\(at). Check the address."
        case NSURLErrorCannotConnectToHost:
            return "Couldn't connect to the server\(at). Check that it's running, that it accepts connections from other devices, and that the phone is on the same network."
        case NSURLErrorTimedOut:
            return "The server\(at) didn't answer in time."
        case NSURLErrorNotConnectedToInternet:
            return "The phone isn't connected to a network."
        default:
            return "\(error.localizedDescription) (server\(at))"
        }
    }
}
