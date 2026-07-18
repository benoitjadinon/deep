// AgentDeck STT 헬퍼 — Apple Speech(SFSpeechRecognizer) + AVAudioEngine.
// ffmpeg 대신 OS 오디오 스택으로 캡처 → Brio 웹캠 노이즈 회피, 한국어 온디바이스 인식.
// .app 번들 + Developer ID 서명으로 실행해야 TCC가 usage description을 신뢰(직접 CLI는 크래시).
//
// 사용:  stt-helper --file <audio>   파일 인식(테스트) /  stt-helper   라이브(SIGINT로 정지)
// 결과는 STT_OUT(기본 /tmp/agentdeck-stt.txt)에 기록.
// ⚠️ 인증은 메인 스레드 블로킹 금지(데드락) → requestAuthorization 콜백 + RunLoop 방식.
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

// 실패 원인 코드를 파일로 → 플러그인이 다이얼에 안내 표시
func writeStatus(_ code: String) { try? code.write(toFile: "/tmp/agentdeck-stt.status", atomically: true, encoding: .utf8) }

let args = CommandLine.arguments
let outPath = ProcessInfo.processInfo.environment["STT_OUT"] ?? "/tmp/agentdeck-stt.txt"
guard let rec = SFSpeechRecognizer(locale: Locale(identifier: "ko-KR")) else { writeStatus("NO_RECOGNIZER"); log("no ko-KR recognizer"); exit(2) }

func writeOut(_ s: String) {
  try? s.write(toFile: outPath, atomically: true, encoding: .utf8)
  print(s)
}

// 파일 모드
func runFile(_ path: String) {
  log("runFile onDevice=\(rec.supportsOnDeviceRecognition) available=\(rec.isAvailable) exists=\(FileManager.default.fileExists(atPath: path))")
  let req = SFSpeechURLRecognitionRequest(url: URL(fileURLWithPath: path))
  req.requiresOnDeviceRecognition = false // 서버/베스트 허용(온디바이스 모델 없어도 되게)
  rec.recognitionTask(with: req) { result, err in
    if let e = err { log("task err: \(e.localizedDescription)"); writeOut(""); exit(1) }
    if let r = result {
      log("result final=\(r.isFinal) text='\(r.bestTranscription.formattedString)'")
      if r.isFinal { writeOut(r.bestTranscription.formattedString); exit(0) }
    }
  }
}

// 라이브 모드 — SIGINT로 정지
var sigSource: DispatchSourceSignal?
func runLive() {
  // 마이크 권한은 음성인식 권한과 별개 → 명시적으로 요청(첫 실행 시 프롬프트)
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
      // 빈 결과로 덮어쓰지 않음(endAudio 후 마지막 콜백이 빈값일 수 있음 → 좋은 결과 유실 방지)
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
  // 플러그인이 SIGINT로 정지시킬 수 있게 PID 기록
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
  guard status == .authorized else { writeStatus("SPEECH_DENIED"); log("speech auth = \(status.rawValue) (거부/미결정)"); exit(3) }
  DispatchQueue.main.async {
    if let i = args.firstIndex(of: "--file"), i + 1 < args.count { runFile(args[i + 1]) } else { runLive() }
  }
}
RunLoop.main.run()
