// Balimda — © 2026 Bandar Altariqi. All rights reserved.
// Licensed under the Balimda License (see LICENSE): non-commercial use only;
// keep the Balimda name and the "Balimda by Bandar Altariqi" credit; no rebranding.

import AVFoundation
import Capacitor
import Foundation
import Speech

/**
 * Voice chat with the iPhone's own speech services: speech recognition
 * (Apple's, or on the iPhone only when "Private voice" is on) and its voices.
 * Same plugin name, methods and events as the Android VoicePlugin.java.
 *
 * listen({lang, offline}) resolves with {text} when the user stops talking
 * ("" if nothing was heard). While listening, "voice" events carry
 * {state: "listening"}, {partial: "..."} and {level: 0..1}.
 * speak({text, lang, rate}) resolves when the text has been spoken; calls
 * queue up, so a reply can be spoken sentence by sentence as it's written.
 */
@objc(VoicePlugin)
public class VoicePlugin: CAPPlugin, CAPBridgedPlugin, AVSpeechSynthesizerDelegate {
    public let identifier = "VoicePlugin"
    public let jsName = "Voice"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "available", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "listen", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "stopListening", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "cancelListening", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "speak", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "stopSpeaking", returnType: CAPPluginReturnPromise)
    ]

    // Everything below is only touched on the main queue.
    private let audioEngine = AVAudioEngine()
    private var request: SFSpeechAudioBufferRecognitionRequest?
    private var task: SFSpeechRecognitionTask?
    private var listenCall: CAPPluginCall?
    private var heard = ""
    private var silenceTimer: Timer?
    private var lastLevel = Date.distantPast

    private let synth = AVSpeechSynthesizer()
    private var speaking: [ObjectIdentifier: CAPPluginCall] = [:]

    // How long a pause ends what the user is saying, and how long to wait for them to start.
    private let pauseToFinish: TimeInterval = 1.5
    private let waitToStart: TimeInterval = 8

    override public func load() {
        synth.delegate = self
    }

    @objc func available(_ call: CAPPluginCall) {
        let lang = call.getString("lang") ?? "en-US"
        let recognizer = SFSpeechRecognizer(locale: Locale(identifier: lang))
        call.resolve([
            "recognition": recognizer != nil && SFSpeechRecognizer.authorizationStatus() != .denied,
            "onDevice": recognizer?.supportsOnDeviceRecognition ?? false,
            "tts": true
        ])
    }

    // ---- listening ------------------------------------------------------------------

    @objc func listen(_ call: CAPPluginCall) {
        SFSpeechRecognizer.requestAuthorization { status in
            guard status == .authorized else {
                call.reject("Balimda needs permission to recognise speech. Allow it in the iPhone's Settings → Balimda → Speech Recognition.", "speech-denied")
                return
            }
            AVAudioSession.sharedInstance().requestRecordPermission { granted in
                DispatchQueue.main.async {
                    guard granted else {
                        call.reject("Balimda needs the microphone to hear you. Allow it in the iPhone's Settings → Balimda → Microphone.", "mic-denied")
                        return
                    }
                    self.startListening(call)
                }
            }
        }
    }

    private func startListening(_ call: CAPPluginCall) {
        finishListening(text: nil, error: nil)
        let lang = call.getString("lang") ?? "en-US"
        let offline = call.getBool("offline") ?? false
        let name = Locale(identifier: "en").localizedString(forIdentifier: lang) ?? lang

        guard let recognizer = SFSpeechRecognizer(locale: Locale(identifier: lang)) else {
            call.reject("The iPhone can't recognise \(name) speech.", "unavailable")
            return
        }
        if offline && !recognizer.supportsOnDeviceRecognition {
            call.reject("This iPhone can't recognise \(name) speech without the internet. Turn off \"Private voice\" in Settings → Voice.", "offline-unavailable")
            return
        }
        guard recognizer.isAvailable else {
            call.reject("Speech recognition isn't available right now. Check the internet connection, or turn on \"Private voice\" in Settings → Voice.", "unavailable")
            return
        }

        let session = AVAudioSession.sharedInstance()
        do {
            try session.setCategory(.playAndRecord, mode: .measurement, options: [.defaultToSpeaker, .duckOthers, .allowBluetooth])
            try session.setActive(true, options: .notifyOthersOnDeactivation)
        } catch {
            call.reject("Couldn't use the microphone: \(error.localizedDescription)")
            return
        }

        let req = SFSpeechAudioBufferRecognitionRequest()
        req.shouldReportPartialResults = true
        if offline { req.requiresOnDeviceRecognition = true }
        if #available(iOS 16, *) { req.addsPunctuation = true }

        let input = audioEngine.inputNode
        let format = input.outputFormat(forBus: 0)
        // No usable microphone (installing a tap on it would crash the app).
        guard format.sampleRate > 0, format.channelCount > 0 else {
            try? session.setActive(false, options: .notifyOthersOnDeactivation)
            call.reject("No microphone is available right now. Try again, or check the iPhone's microphone.", "no-mic")
            return
        }
        input.removeTap(onBus: 0)
        input.installTap(onBus: 0, bufferSize: 1024, format: format) { [weak self] buffer, _ in
            req.append(buffer)
            self?.reportLevel(buffer)
        }
        audioEngine.prepare()
        do {
            try audioEngine.start()
        } catch {
            input.removeTap(onBus: 0)
            call.reject("Couldn't start the microphone: \(error.localizedDescription)")
            return
        }

        request = req
        listenCall = call
        heard = ""
        task = recognizer.recognitionTask(with: req) { [weak self] result, error in
            DispatchQueue.main.async {
                guard let self = self, self.request === req else { return }
                if let result = result {
                    self.heard = result.bestTranscription.formattedString
                    self.notifyListeners("voice", data: ["partial": self.heard])
                    if result.isFinal {
                        self.finishListening(text: self.heard, error: nil)
                    } else {
                        self.waitForPause(self.pauseToFinish)
                    }
                } else if error != nil {
                    // Nothing recognisable was said, or listening was stopped.
                    self.finishListening(text: self.heard, error: nil)
                }
            }
        }
        notifyListeners("voice", data: ["state": "listening"])
        waitForPause(waitToStart)
    }

    // Ends listening after `seconds` without new words.
    private func waitForPause(_ seconds: TimeInterval) {
        silenceTimer?.invalidate()
        silenceTimer = Timer.scheduledTimer(withTimeInterval: seconds, repeats: false) { [weak self] _ in
            self?.endAudio()
        }
    }

    // Stops recording; the recognizer then sends its final result.
    private func endAudio() {
        guard let req = request else { return }
        silenceTimer?.invalidate()
        audioEngine.stop()
        audioEngine.inputNode.removeTap(onBus: 0)
        req.endAudio()
        notifyListeners("voice", data: ["state": "thinking"])
        // In case the final result never comes.
        silenceTimer = Timer.scheduledTimer(withTimeInterval: 3, repeats: false) { [weak self] _ in
            guard let self = self, self.request === req else { return }
            self.finishListening(text: self.heard, error: nil)
        }
    }

    private func reportLevel(_ buffer: AVAudioPCMBuffer) {
        guard let data = buffer.floatChannelData?[0], buffer.frameLength > 0 else { return }
        var sum: Float = 0
        for i in 0..<Int(buffer.frameLength) { sum += data[i] * data[i] }
        let rms = sqrt(sum / Float(buffer.frameLength))
        let level = max(0, min(1, (20 * log10(max(rms, 1e-6)) + 50) / 40))
        DispatchQueue.main.async {
            let now = Date()
            guard now.timeIntervalSince(self.lastLevel) > 0.1 else { return }
            self.lastLevel = now
            self.notifyListeners("voice", data: ["level": level])
        }
    }

    private func finishListening(text: String?, error: String?) {
        silenceTimer?.invalidate()
        silenceTimer = nil
        if audioEngine.isRunning {
            audioEngine.stop()
            audioEngine.inputNode.removeTap(onBus: 0)
        }
        request?.endAudio()
        request = nil
        task?.cancel()
        task = nil
        // Back to playback, so replies are spoken through the speaker at full volume.
        try? AVAudioSession.sharedInstance().setCategory(.playback, mode: .spokenAudio, options: [.duckOthers])

        guard let call = listenCall else { return }
        listenCall = nil
        if let error = error {
            call.reject(error)
        } else {
            call.resolve(["text": (text ?? "").trimmingCharacters(in: .whitespacesAndNewlines)])
        }
    }

    @objc func stopListening(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            self.endAudio()
            call.resolve()
        }
    }

    @objc func cancelListening(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            self.finishListening(text: "", error: nil)
            call.resolve()
        }
    }

    // ---- speaking -------------------------------------------------------------------

    @objc func speak(_ call: CAPPluginCall) {
        let text = call.getString("text") ?? ""
        let lang = call.getString("lang") ?? "en-US"
        let rate = Float(call.getDouble("rate") ?? 1.0)
        DispatchQueue.main.async {
            guard let voice = AVSpeechSynthesisVoice(language: lang) else {
                let name = Locale(identifier: "en").localizedString(forIdentifier: lang) ?? lang
                call.reject("This iPhone has no \(name) voice. Add one in Settings → Accessibility → Spoken Content → Voices.", "no-voice")
                return
            }
            if self.listenCall == nil {
                try? AVAudioSession.sharedInstance().setCategory(.playback, mode: .spokenAudio, options: [.duckOthers])
                try? AVAudioSession.sharedInstance().setActive(true)
            }
            let utterance = AVSpeechUtterance(string: text)
            utterance.voice = voice
            utterance.rate = max(AVSpeechUtteranceMinimumSpeechRate, min(AVSpeechUtteranceMaximumSpeechRate, AVSpeechUtteranceDefaultSpeechRate * rate))
            self.speaking[ObjectIdentifier(utterance)] = call
            self.synth.speak(utterance)
        }
    }

    @objc func stopSpeaking(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            self.synth.stopSpeaking(at: .immediate)
            // Queued sentences are dropped without a callback.
            for (_, pending) in self.speaking { pending.resolve(["interrupted": true]) }
            self.speaking.removeAll()
            call.resolve()
        }
    }

    public func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didFinish utterance: AVSpeechUtterance) {
        DispatchQueue.main.async {
            self.speaking.removeValue(forKey: ObjectIdentifier(utterance))?.resolve(["interrupted": false])
        }
    }

    public func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didCancel utterance: AVSpeechUtterance) {
        DispatchQueue.main.async {
            self.speaking.removeValue(forKey: ObjectIdentifier(utterance))?.resolve(["interrupted": true])
        }
    }
}
