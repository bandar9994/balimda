// Balimda — © 2026 Bandar Altariqi. All rights reserved.
// Licensed under the Balimda License (see LICENSE): non-commercial use only;
// keep the Balimda name and the "Balimda by Bandar Altariqi" credit; no rebranding.

import Foundation
import Capacitor
import BalimdaEngine

/**
 * On-device models on iPhone and iPad: llama.cpp on the Apple GPU (Metal),
 * through the engine shared with the Android app (native/llama/engine).
 * Same plugin name, methods and events as the Android LlamaPlugin.java, so
 * mobile/src/native-engine.js works unchanged.
 *
 * Events: "token" {requestId, text}, "status" {requestId, status, device},
 *         "download" {url, loaded, total, done, error}
 */
@objc(LlamaPlugin)
public class LlamaPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "LlamaPlugin"
    public let jsName = "Llama"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "info", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "listModels", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "deleteModel", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "download", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "cancelDownload", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "generate", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "stop", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "unloadModel", returnType: CAPPluginReturnPromise)
    ]

    // One model in memory, used by one reply at a time.
    private let inference = DispatchQueue(label: "balimda.llama.inference", qos: .userInitiated)
    private let lock = NSLock()
    private var activeRequests: [String: StopFlag] = [:]
    private var downloads: [String: Download] = [:]
    private var activeParts = Set<String>()

    // Loaded model (only touched on the inference queue).
    private var engine: OpaquePointer?
    private var loadedKey: String?
    private var loadedDevice = "CPU"
    private var loadedOffload = ""

    // ---- files -----------------------------------------------------------------

    // Application Support/models, left out of iCloud backups (models are large
    // and can be downloaded again).
    private func modelsDir() -> URL {
        let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        var dir = base.appendingPathComponent("models", isDirectory: true)
        if !FileManager.default.fileExists(atPath: dir.path) {
            try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
            var values = URLResourceValues()
            values.isExcludedFromBackup = true
            try? dir.setResourceValues(values)
        }
        return dir
    }

    private func modelFile(_ name: String) -> URL {
        let safe = name.replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "\\", with: "_")
        return modelsDir().appendingPathComponent(safe)
    }

    private static func fileName(for url: String) throws -> String {
        guard let u = URL(string: url) else { throw PluginError("The link isn't valid") }
        let last = (u.path as NSString).lastPathComponent.removingPercentEncoding ?? u.lastPathComponent
        let name = String(last.map { ch -> Character in
            (ch.isASCII && (ch.isLetter || ch.isNumber || ch == "." || ch == "_" || ch == "-")) ? ch : "_"
        })
        guard name.lowercased().hasSuffix(".gguf") else { throw PluginError("The link must point to a .gguf file") }
        return name
    }

    private func fileSize(_ url: URL) -> Int64 {
        ((try? FileManager.default.attributesOfItem(atPath: url.path)[.size]) as? NSNumber)?.int64Value ?? 0
    }

    // ---- record of downloads ------------------------------------------------------
    // Which models Balimda downloaded. A model only leaves the record when it is
    // deleted in Balimda, so a recorded model whose file is gone was removed by
    // something else, and the app can say so and offer it again.

    private func recordFile() -> URL {
        FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("models-record.json")
    }

    private func readRecord() -> [String: [String: Any]] {
        guard let data = try? Data(contentsOf: recordFile()),
              let obj = try? JSONSerialization.jsonObject(with: data) as? [String: [String: Any]] else { return [:] }
        return obj
    }

    private func writeRecord(_ record: [String: [String: Any]]) {
        guard let data = try? JSONSerialization.data(withJSONObject: record) else { return }
        try? data.write(to: recordFile(), options: .atomic)
    }

    private func noteDownloaded(_ name: String, url: String?, size: Int64) {
        lock.lock()
        defer { lock.unlock() }
        var record = readRecord()
        var entry: [String: Any] = ["size": size, "at": Int64(Date().timeIntervalSince1970 * 1000)]
        if let url = url { entry["url"] = url }
        record[name] = entry
        writeRecord(record)
    }

    private func noteDeleted(_ name: String) {
        lock.lock()
        defer { lock.unlock() }
        var record = readRecord()
        if record.removeValue(forKey: name) != nil { writeRecord(record) }
    }

    private func wasDownloaded(_ name: String) -> Bool {
        lock.lock()
        defer { lock.unlock() }
        return readRecord()[name] != nil
    }

    // ---- info -------------------------------------------------------------------

    private static func devices() -> [[String: String]] {
        guard let raw = be_devices() else { return [] }
        defer { be_string_free(raw) }
        return String(cString: raw).split(separator: "\n").compactMap { line in
            let parts = line.split(separator: "\t", omittingEmptySubsequences: false).map(String.init)
            return parts.count >= 3 ? ["type": parts[0], "name": parts[1], "description": parts[2]] : nil
        }
    }

    @objc func info(_ call: CAPPluginCall) {
        call.resolve(["available": true, "devices": LlamaPlugin.devices()])
    }

    // ---- model files ----------------------------------------------------------------

    @objc func listModels(_ call: CAPPluginCall) {
        let fm = FileManager.default
        let files = (try? fm.contentsOfDirectory(at: modelsDir(), includingPropertiesForKeys: nil)) ?? []
        lock.lock()
        let parts = activeParts
        lock.unlock()
        var present = Set<String>()
        var models: [[String: Any]] = []
        let record = readRecordLocked()
        for f in files {
            let name = f.lastPathComponent
            if name.hasSuffix(".part") && !parts.contains(name) {
                try? fm.removeItem(at: f)  // left by a download the app was closed during
                continue
            }
            guard name.hasSuffix(".gguf") else { continue }
            present.insert(name)
            if record[name] == nil { noteDownloaded(name, url: nil, size: fileSize(f)) }
            models.append(["name": name, "size": fileSize(f)])
        }
        // On the record but gone from the phone, without being deleted in Balimda.
        var missing: [[String: Any]] = []
        for (name, entry) in record where !present.contains(name) {
            var m: [String: Any] = ["name": name, "size": entry["size"] ?? 0, "at": entry["at"] ?? 0]
            if let url = entry["url"] { m["url"] = url }
            missing.append(m)
        }
        call.resolve(["models": models, "missing": missing])
    }

    private func readRecordLocked() -> [String: [String: Any]] {
        lock.lock()
        defer { lock.unlock() }
        return readRecord()
    }

    @objc func deleteModel(_ call: CAPPluginCall) {
        let name = call.getString("name") ?? ""
        inference.async {
            let f = self.modelFile(name)
            if let key = self.loadedKey, key.hasPrefix(f.path + "|") { self.unload() }
            var ok = true
            if FileManager.default.fileExists(atPath: f.path) {
                ok = (try? FileManager.default.removeItem(at: f)) != nil
            }
            if ok { self.noteDeleted(f.lastPathComponent) }
            call.resolve(["deleted": ok])
        }
    }

    @objc func download(_ call: CAPPluginCall) {
        let url = call.getString("url") ?? ""
        let name: String
        do {
            name = try LlamaPlugin.fileName(for: url)
        } catch {
            call.reject(error.localizedDescription)
            return
        }
        guard let source = URL(string: url) else {
            call.reject("The link isn't valid")
            return
        }
        let target = modelFile(name)
        let part = target.appendingPathExtension("part")
        let job = Download(url: url, source: source, part: part, target: target) { [weak self] loaded, total, done, error in
            guard let self = self else { return }
            if done {
                self.lock.lock()
                self.activeParts.remove(part.lastPathComponent)
                self.downloads.removeValue(forKey: url)
                self.lock.unlock()
                if error == nil { self.noteDownloaded(target.lastPathComponent, url: url, size: self.fileSize(target)) }
            }
            var evt: [String: Any] = ["url": url, "loaded": loaded, "total": total, "done": done]
            if let error = error { evt["error"] = error }
            self.notifyListeners("download", data: evt)
        }
        lock.lock()
        activeParts.insert(part.lastPathComponent)
        downloads[url] = job
        lock.unlock()
        call.resolve(["name": name])
        job.start()
    }

    @objc func cancelDownload(_ call: CAPPluginCall) {
        let url = call.getString("url") ?? ""
        lock.lock()
        let job = downloads[url]
        lock.unlock()
        job?.cancel()
        call.resolve()
    }

    // ---- inference ------------------------------------------------------------------

    private func unload() {
        if let e = engine {
            be_free(e)
            engine = nil
        }
        loadedKey = nil
    }

    private static func threadCount() -> Int32 {
        // The performance cores; the efficiency cores slow generation down.
        Int32(max(1, min(4, ProcessInfo.processInfo.activeProcessorCount - 2)))
    }

    // When the GPU does the work, extra CPU threads only wait for it.
    private static let gpuThreads: Int32 = 2

    /// "GPU · Apple A17 Pro GPU" when layers were offloaded, else "CPU".
    private static func describeDevice(_ offload: String) -> String {
        let pattern = try? NSRegularExpression(pattern: "offloaded (\\d+)/(\\d+)")
        let range = NSRange(offload.startIndex..., in: offload)
        guard let m = pattern?.firstMatch(in: offload, range: range),
              let r = Range(m.range(at: 1), in: offload), Int(offload[r]) ?? 0 > 0 else { return "CPU" }
        if let gpu = devices().first(where: { $0["type"] == "gpu" }), let desc = gpu["description"], !desc.isEmpty {
            return "GPU · \(desc)"
        }
        return "GPU"
    }

    private func load(path: String, nCtx: Int32, gpuLayers: Int32, threads: Int32) throws {
        var error: UnsafeMutablePointer<CChar>?
        guard let e = be_load(path, nCtx, gpuLayers, threads, &error) else {
            let message = error.map { String(cString: $0) } ?? "Couldn't load the model."
            be_string_free(error)
            throw PluginError(message)
        }
        engine = e
        loadedOffload = String(cString: be_offload(e))
        loadedDevice = LlamaPlugin.describeDevice(loadedOffload)
    }

    private func emitStatus(_ requestId: String, _ status: String) {
        var evt: [String: Any] = ["requestId": requestId, "status": status]
        // Once the model is loaded, say where it runs (e.g. "GPU · Apple A17 Pro GPU").
        if status == "thinking" { evt["device"] = loadedDevice }
        notifyListeners("status", data: evt)
    }

    @objc func generate(_ call: CAPPluginCall) {
        let requestId = call.getString("requestId") ?? ""
        let model = call.getString("model") ?? ""
        let nCtx = Int32(call.getInt("contextSize") ?? 4096)
        let gpu = call.getBool("gpu") ?? true
        let maxTokens = Int32(call.getInt("maxTokens") ?? 1024)
        let temperature = Float(call.getDouble("temperature") ?? 0.7)
        let messages = call.getArray("messages", JSObject.self) ?? []

        let stop = StopFlag()
        lock.lock()
        activeRequests[requestId] = stop
        lock.unlock()

        inference.async {
            defer {
                self.lock.lock()
                self.activeRequests.removeValue(forKey: requestId)
                self.lock.unlock()
            }
            do {
                let file = self.modelFile(model)
                if !FileManager.default.fileExists(atPath: file.path) {
                    if self.wasDownloaded(file.lastPathComponent) {
                        throw PluginError("\"\(model)\" was removed from this phone, but not by Balimda (it only deletes a model when you tap Delete). Download it again in Settings → Models & providers.")
                    }
                    throw PluginError("\"\(model)\" isn't downloaded. Download it in Settings → Models & providers.")
                }
                let key = "\(file.path)|\(nCtx)|\(gpu)"
                if key != self.loadedKey {
                    self.unload()
                    self.emitStatus(requestId, "loading")
                    try self.load(path: file.path, nCtx: nCtx, gpuLayers: gpu ? 99 : 0,
                                  threads: gpu ? LlamaPlugin.gpuThreads : LlamaPlugin.threadCount())
                    if gpu && self.loadedDevice == "CPU" {
                        // The GPU couldn't take the model: load it again with all CPU threads.
                        self.unload()
                        try self.load(path: file.path, nCtx: nCtx, gpuLayers: 0, threads: LlamaPlugin.threadCount())
                    }
                    self.loadedKey = key
                }
                if stop.value {
                    call.resolve(["stopReason": "aborted"])
                    return
                }
                self.emitStatus(requestId, "thinking")

                let roles = messages.map { ($0["role"] as? String) ?? "user" }
                let contents = messages.map { ($0["content"] as? String) ?? "" }
                let sink = TokenSink { text in
                    if !text.isEmpty {
                        self.notifyListeners("token", data: ["requestId": requestId, "text": text])
                    }
                    return !stop.value
                }
                let result = try self.complete(roles: roles, contents: contents, maxTokens: maxTokens,
                                               temperature: temperature, sink: sink)
                call.resolve(self.resultObject(result))
            } catch {
                call.reject(error.localizedDescription)
            }
        }
    }

    private func complete(roles: [String], contents: [String], maxTokens: Int32, temperature: Float,
                          sink: TokenSink) throws -> String {
        guard let e = engine else { throw PluginError("Model is not loaded") }
        let rolePtrs: [UnsafePointer<CChar>?] = roles.map { UnsafePointer(strdup($0)) }
        let contentPtrs: [UnsafePointer<CChar>?] = contents.map { UnsafePointer(strdup($0)) }
        defer {
            rolePtrs.forEach { free(UnsafeMutablePointer(mutating: $0)) }
            contentPtrs.forEach { free(UnsafeMutablePointer(mutating: $0)) }
        }
        let onToken: be_token_fn = { user, text in
            guard let user = user, let text = text else { return true }
            return Unmanaged<TokenSink>.fromOpaque(user).takeUnretainedValue().handle(String(cString: text))
        }
        var error: UnsafeMutablePointer<CChar>?
        let user = Unmanaged.passUnretained(sink).toOpaque()
        let raw = withExtendedLifetime(sink) {
            be_complete(e, rolePtrs, contentPtrs, Int32(roles.count), maxTokens, temperature, onToken, user, &error)
        }
        guard let raw = raw else {
            let message = error.map { String(cString: $0) } ?? "The model failed."
            be_string_free(error)
            throw PluginError(message)
        }
        defer { be_string_free(raw) }
        return String(cString: raw)
    }

    /// result = "reason\tpromptTokens\tpromptMs\tgeneratedTokens\tgenerationMs\tchatTokens\tmessagesSent\tcontextSize"
    private func resultObject(_ result: String) -> [String: Any] {
        let parts = result.split(separator: "\t", omittingEmptySubsequences: false).map(String.init)
        var ret: [String: Any] = ["stopReason": parts.first ?? "end_turn"]
        if parts.count >= 5 {
            var stats: [String: Any] = [
                "device": loadedDevice,
                "offload": loadedOffload,
                "promptTokens": Int(parts[1]) ?? 0,
                "promptMs": Double(parts[2]) ?? 0,
                "tokens": Int(parts[3]) ?? 0,
                "ms": Double(parts[4]) ?? 0
            ]
            if parts.count >= 8 {
                stats["chatTokens"] = Int(parts[5]) ?? 0
                stats["messagesSent"] = Int(parts[6]) ?? 0
                stats["contextSize"] = Int(parts[7]) ?? 0
            }
            ret["stats"] = stats
        }
        return ret
    }

    @objc func stop(_ call: CAPPluginCall) {
        lock.lock()
        let flag = activeRequests[call.getString("requestId") ?? ""]
        lock.unlock()
        flag?.value = true
        call.resolve()
    }

    @objc func unloadModel(_ call: CAPPluginCall) {
        inference.async {
            self.unload()
            call.resolve()
        }
    }
}

// ---- helpers ------------------------------------------------------------------------

struct PluginError: LocalizedError {
    let message: String
    init(_ message: String) { self.message = message }
    var errorDescription: String? { message }
}

final class StopFlag {
    private let lock = NSLock()
    private var stopped = false
    var value: Bool {
        get { lock.lock(); defer { lock.unlock() }; return stopped }
        set { lock.lock(); stopped = newValue; lock.unlock() }
    }
}

/// Receives the reply's pieces from the C engine; returns false to stop.
final class TokenSink {
    let handle: (String) -> Bool
    init(_ handle: @escaping (String) -> Bool) { self.handle = handle }
}

/// One model download, with progress, written to a .part file first.
final class Download: NSObject, URLSessionDownloadDelegate {
    typealias Progress = (_ loaded: Int64, _ total: Int64, _ done: Bool, _ error: String?) -> Void

    let url: String
    private let source: URL
    private let part: URL
    private let target: URL
    private let progress: Progress
    private var session: URLSession?
    private var lastEmit = Date.distantPast
    private var cancelled = false

    init(url: String, source: URL, part: URL, target: URL, progress: @escaping Progress) {
        self.url = url
        self.source = source
        self.part = part
        self.target = target
        self.progress = progress
    }

    func start() {
        let config = URLSessionConfiguration.default
        config.timeoutIntervalForRequest = 60
        session = URLSession(configuration: config, delegate: self, delegateQueue: nil)
        session?.downloadTask(with: source).resume()
    }

    func cancel() {
        cancelled = true
        session?.invalidateAndCancel()
    }

    func urlSession(_ session: URLSession, downloadTask: URLSessionDownloadTask, didWriteData bytesWritten: Int64,
                    totalBytesWritten: Int64, totalBytesExpectedToWrite: Int64) {
        let now = Date()
        if now.timeIntervalSince(lastEmit) > 0.3 {
            lastEmit = now
            progress(totalBytesWritten, totalBytesExpectedToWrite, false, nil)
        }
    }

    func urlSession(_ session: URLSession, downloadTask: URLSessionDownloadTask, didFinishDownloadingTo location: URL) {
        let fm = FileManager.default
        if let http = downloadTask.response as? HTTPURLResponse, http.statusCode != 200 {
            finish(error: "Download failed (HTTP \(http.statusCode))")
            return
        }
        do {
            // The temporary file is deleted when this method returns: move it now.
            try? fm.removeItem(at: part)
            try fm.moveItem(at: location, to: part)
            let expected = downloadTask.countOfBytesExpectedToReceive
            let size = ((try? fm.attributesOfItem(atPath: part.path)[.size]) as? NSNumber)?.int64Value ?? 0
            if expected > 0 && size != expected { throw PluginError("Download was interrupted; please retry.") }
            try? fm.removeItem(at: target)
            try fm.moveItem(at: part, to: target)
            finish(error: nil, size: size)
        } catch {
            try? fm.removeItem(at: part)
            finish(error: error.localizedDescription)
        }
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        guard let error = error else { return }
        try? FileManager.default.removeItem(at: part)
        finish(error: cancelled ? "cancelled" : error.localizedDescription)
    }

    private var finished = false
    private func finish(error: String?, size: Int64 = 0) {
        guard !finished else { return }
        finished = true
        progress(size, size, true, error)
        session?.finishTasksAndInvalidate()
    }
}
