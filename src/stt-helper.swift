// AgentDeck STT Helper — Apple Speech (SFSpeechRecognizer) + AVAudioEngine.
// Captures via OS audio stack instead of ffmpeg -> avoids webcam mic noise, uses on-device recognition when available.
// Recognition language defaults to system locale — overridable via file or environment variable.
// Must run as signed .app bundle so macOS TCC trusts usage descriptions.
//
// Usage:  stt-helper --file <audio>   File recognition (test) /  stt-helper   Live mode (stopped via SIGINT)
// Results written to STT_OUT (default /tmp/agentdeck-stt.txt).
// Locale override: STT_LOCALE env var or /tmp/agentdeck-stt.locale file (defaults to system locale if omitted).
import Foundation
import Speech
import AVFoundation

func log(_ s: String) {
  FileHandle.standardError.write((s + "\n").data(using: .utf8)!)
  if let d = (s + "\n").data(using: .utf8) {
    let p = "/tmp/agentdeck-stt.log"
    if let fh = FileHandle(forWritingAtPath: p) { fh.seekToEndOfFile(); fh.write(d); fh.closeFile() }
    else { try? (s + "\n").write(toFile: p, atomically: true, encoding: .utf8) }
  }
}

// Write status code to file so plugin can display guidance on dial
func writeStatus(_ code: String) { try? code.write(toFile: "/tmp/agentdeck-stt.status", atomically: true, encoding: .utf8) }

let args = CommandLine.arguments
let outPath = ProcessInfo.processInfo.environment["STT_OUT"] ?? "/tmp/agentdeck-stt.txt"

// Determine recognition locale:
// 1) Explicit override (priority): STT_LOCALE env var or /tmp/agentdeck-stt.locale file (e.g. en-US, ko-KR, ja-JP)
// 2) System default: SFSpeechRecognizer()
func resolveRecognizer() -> SFSpeechRecognizer? {
  var explicit: String?
  if let e = ProcessInfo.processInfo.environment["STT_LOCALE"], !e.isEmpty {
    explicit = e
  } else if let c = try? String(contentsOfFile: "/tmp/agentdeck-stt.locale", encoding: .utf8) {
    let t = c.trimmingCharacters(in: .whitespacesAndNewlines)
    if !t.isEmpty { explicit = t }
  }
  if let ov = explicit {
    log("STT locale override: \(ov)")
    return SFSpeechRecognizer(locale: Locale(identifier: ov))
  }
  let rec = SFSpeechRecognizer()
  log("STT locale system default: \(rec?.locale.identifier ?? "nil")")
  return rec
}
let rec: SFSpeechRecognizer
if let r = resolveRecognizer() {
  rec = r
  log("STT rec locale=\(rec.locale.identifier) onDevice=\(rec.supportsOnDeviceRecognition) available=\(rec.isAvailable)")
} else {
  writeStatus("NO_RECOGNIZER"); log("no recognizer for requested language"); exit(2)
}

func writeOut(_ s: String) {
  try? s.write(toFile: outPath, atomically: true, encoding: .utf8)
  print(s)
}

// File mode
func runFile(_ path: String) {
  log("runFile onDevice=\(rec.supportsOnDeviceRecognition) available=\(rec.isAvailable) exists=\(FileManager.default.fileExists(atPath: path))")
  let req = SFSpeechURLRecognitionRequest(url: URL(fileURLWithPath: path))
  req.requiresOnDeviceRecognition = false
  rec.recognitionTask(with: req) { result, err in
    if let e = err { log("task err: \(e.localizedDescription)"); writeOut(""); exit(1) }
    if let r = result {
      log("result final=\(r.isFinal) text='\(r.bestTranscription.formattedString)'")
      if r.isFinal { writeOut(r.bestTranscription.formattedString); exit(0) }
    }
  }
}

// Live mode — stopped via SIGINT
var sigSource: DispatchSourceSignal?
func runLive() {
  // Request mic permission
  AVCaptureDevice.requestAccess(for: .audio) { granted in
    guard granted else { writeStatus("MIC_DENIED"); log("mic not granted"); exit(5) }
    DispatchQueue.main.async { startEngine() }
  }
}
func startEngine() {
  let engine = AVAudioEngine()
  let req = SFSpeechAudioBufferRecognitionRequest()
  req.requiresOnDeviceRecognition = rec.supportsOnDeviceRecognition
  var latest = ""
  let task = rec.recognitionTask(with: req) { result, err in
    if let e = err { let m = e.localizedDescription; log("live task err: \(m)"); if m.contains("Dictation") || m.contains("Siri") { writeStatus("DICTATION_OFF") } }
    if let r = result {
      let t = r.bestTranscription.formattedString
      if !t.isEmpty {
        latest = t
        try? t.write(toFile: "/tmp/agentdeck-stt.partial", atomically: true, encoding: .utf8)
      }
    }
  }
  let input = engine.inputNode
  let f = input.outputFormat(forBus: 0)
  log("input fmt sr=\(f.sampleRate) ch=\(f.channelCount)")
  var bufCount = 0
  input.installTap(onBus: 0, bufferSize: 2048, format: f) { buf, _ in
    req.append(buf)
    bufCount += 1
    if bufCount % 25 == 0 {
      let d = buf.floatChannelData?[0]
      var peak: Float = 0
      if let d = d { for i in 0..<Int(buf.frameLength) { peak = max(peak, abs(d[i])) } }
      log("buf#\(bufCount) peak=\(peak)")
    }
  }
  engine.prepare()
  do { try engine.start() } catch { log("engine start \(error.localizedDescription)"); exit(4) }
  // Record PID so plugin can stop process via SIGINT
  try? "\(ProcessInfo.processInfo.processIdentifier)".write(toFile: "/tmp/agentdeck-stt.pid", atomically: true, encoding: .utf8)
  log("REC on-device=\(rec.supportsOnDeviceRecognition)")
  signal(SIGINT, SIG_IGN)
  let s = DispatchSource.makeSignalSource(signal: SIGINT, queue: .main)
  s.setEventHandler {
    log("SIGINT stop, latest='\(latest)' bufs=\(bufCount)")
    input.removeTap(onBus: 0)
    engine.stop()
    req.endAudio()
    DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) { task.cancel(); writeOut(latest); exit(0) }
  }
  s.resume()
  sigSource = s
}

SFSpeechRecognizer.requestAuthorization { status in
  guard status == .authorized else { writeStatus("SPEECH_DENIED"); log("speech auth = \(status.rawValue) (denied/not-determined)"); exit(3) }
  DispatchQueue.main.async {
    if let i = args.firstIndex(of: "--file"), i + 1 < args.count { runFile(args[i + 1]) } else { runLive() }
  }
}
RunLoop.main.run()
