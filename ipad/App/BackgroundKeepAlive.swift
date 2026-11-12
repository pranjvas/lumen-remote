import AVFoundation
import Foundation

// iPadOS suspends an app shortly after it leaves the screen, which would stop the Lumen
// server. An app that is playing audio is allowed to keep running, so this plays silence
// (mixed with whatever else is playing) while "Keep running in the background" is on.
final class BackgroundKeepAlive {
    private var player: AVAudioPlayer?
    private var observing = false

    var isRunning: Bool {
        player?.isPlaying ?? false
    }

    func start() {
        if isRunning { return }
        do {
            let session = AVAudioSession.sharedInstance()
            try session.setCategory(.playback, mode: .default, options: [.mixWithOthers])
            try session.setActive(true)
            if player == nil {
                let silence = try AVAudioPlayer(data: BackgroundKeepAlive.silentWav(seconds: 2))
                silence.numberOfLoops = -1
                silence.volume = 0
                player = silence
            }
            player?.play()
        } catch {
            NSLog("Lumen: background keep-alive could not start: %@", error.localizedDescription)
        }
        observeInterruptions()
    }

    func stop() {
        player?.stop()
        player = nil
        try? AVAudioSession.sharedInstance().setActive(false, options: [.notifyOthersOnDeactivation])
    }

    // A phone call or another app can interrupt the audio session; start again when it ends.
    private func observeInterruptions() {
        if observing { return }
        observing = true
        NotificationCenter.default.addObserver(
            forName: AVAudioSession.interruptionNotification,
            object: nil,
            queue: .main
        ) { [weak self] note in
            guard let self = self, self.player != nil else { return }
            let raw = note.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt
            if raw == AVAudioSession.InterruptionType.ended.rawValue {
                try? AVAudioSession.sharedInstance().setActive(true)
                self.player?.play()
            }
        }
    }

    // A short mono 16-bit WAV file that contains only silence.
    private static func silentWav(seconds: Int) -> Data {
        let sampleRate: UInt32 = 8000
        let dataSize: UInt32 = UInt32(seconds) * sampleRate * 2
        var bytes: [UInt8] = []

        func text(_ value: String) {
            bytes.append(contentsOf: Array(value.utf8))
        }
        func u32(_ value: UInt32) {
            bytes.append(UInt8(value & 0xFF))
            bytes.append(UInt8((value >> 8) & 0xFF))
            bytes.append(UInt8((value >> 16) & 0xFF))
            bytes.append(UInt8((value >> 24) & 0xFF))
        }
        func u16(_ value: UInt16) {
            bytes.append(UInt8(value & 0xFF))
            bytes.append(UInt8((value >> 8) & 0xFF))
        }

        text("RIFF")
        u32(36 + dataSize)
        text("WAVE")
        text("fmt ")
        u32(16)
        u16(1)
        u16(1)
        u32(sampleRate)
        u32(sampleRate * 2)
        u16(2)
        u16(16)
        text("data")
        u32(dataSize)

        var data = Data(bytes)
        data.append(Data(count: Int(dataSize)))
        return data
    }
}
