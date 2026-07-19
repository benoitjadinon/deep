// AgentDeck Stream Deck 플러그인 진입점.
// orca를 폴링해 8칸에 세션 상태를 그리고, keyDown/다이얼로 orca를 조작한다.
// 다이얼은 위치(열)로 역할 결정: 0=모델 1=Effort 2=Talk 3=대상선택.
import streamDeck, { action, SingletonAction } from "@elgato/streamdeck";
import { execFile } from "node:child_process";
import { writeFileSync, readFileSync, existsSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { buildDeck, needsAttention, type Deck } from "./deck";
import { keyImage, dialImage } from "./render";

const execFileP = promisify(execFile);
// 머신마다 설치 위치가 다르므로 공통 경로를 탐색(하드코딩 제거 = 다른 맥에서도 동작)
function firstExisting(candidates: string[], fallback: string): string {
  for (const p of candidates) if (existsSync(p)) return p;
  return fallback;
}
const ORCA = firstExisting(["/usr/local/bin/orca", "/opt/homebrew/bin/orca"], "orca");
// Apple Speech STT 헬퍼 — plugin.js와 같은 bin/ 폴더에 동봉(상대 경로)
const STT_APP = join(__dirname, "SttHelper.app");
const STT_TXT = "/tmp/agentdeck-stt.txt";
const STT_PID = "/tmp/agentdeck-stt.pid";
const STT_PARTIAL = "/tmp/agentdeck-stt.partial"; // 실시간 부분 인식결과
const STT_STATUS = "/tmp/agentdeck-stt.status"; // 실패 원인 코드
// 실패 코드 → 다이얼에 띄울 한글 안내
const TALK_HINT: Record<string, string> = {
  MIC_DENIED: "마이크 권한 켜기",
  SPEECH_DENIED: "음성인식 권한 켜기",
  DICTATION_OFF: "받아쓰기 켜기",
  NO_RECOGNIZER: "한국어 STT 없음",
  MIC_ERR: "마이크 오류",
};
const talkHint = (code: string) => TALK_HINT[code] ?? "STT 오류";
const EXEC = { maxBuffer: 64 * 1024 * 1024 } as const;

const MODELS = ["opus", "sonnet", "haiku"];
const EFFORTS = ["low", "medium", "high", "xhigh", "ultracode"];

async function orcaJson(args: string[]): Promise<any> {
  const { stdout } = await execFileP(ORCA, [...args, "--json"], EXEC);
  return JSON.parse(stdout);
}
async function orcaRun(args: string[]): Promise<void> {
  await execFileP(ORCA, args, EXEC);
}
// Orca가 백그라운드(다른 앱에 포커스)면 앞으로 가져온다 — 키 탭/대상 점프 시 창이 안 뜨는 문제 해결.
// 이미 앞이면 no-op. `open -b <bundle>`은 실행중이면 activate, 아니면 실행.
async function focusOrca(): Promise<void> {
  try {
    await execFileP("/usr/bin/open", ["-b", "com.stablyai.orca"], EXEC);
  } catch (e) {
    streamDeck.logger.error(`focus orca: ${e}`);
  }
}

// 수동 이동(다이얼 회전/키 탭) 시각 — 직후 poll 자동추적이 수동 선택을 덮어쓰지 않게 하는 유예용.
let lastNav = 0;
// 대상 다이얼을 빠르게 돌릴 때 매 틱 orca switch를 쏘면 포커스가 밀림 → 마지막 선택으로 디바운스(180ms).
let targetSwitchTimer: ReturnType<typeof setTimeout> | null = null;
function switchTargetSoon(handle: string): void {
  if (targetSwitchTimer) clearTimeout(targetSwitchTimer);
  targetSwitchTimer = setTimeout(() => {
    targetSwitchTimer = null;
    orcaRun(["terminal", "switch", "--terminal", handle]).catch(() => {});
  }, 180);
}

let currentPage = 0;
let deck: Deck = buildDeck({ terminals: [], worktrees: [] }, { page: 0, perPage: 8 });
let tick = 0;

// 다이얼 대상/설정 상태
let targetHandle: string | undefined; // 다이얼이 작용할 세션(키 탭 or 4번 다이얼로 선택)
let pendingEffort = "medium"; // 2번 다이얼로 '고른' effort(누르기 전엔 미적용)
let pendingModel = MODELS[0]; // 1번 다이얼로 '고른' 모델(누르기 전엔 미적용)
const modelByHandle = new Map<string, string>(); // 세션별 마지막 '적용'된 모델
const effortByHandle = new Map<string, string>(); // 세션별 마지막 '적용'된 effort
let allHandles: string[] = []; // 모든 세션(최근순) 핸들 — 8키 페이지와 무관, 사이드바 전체
const sessionByHandle = new Map<string, any>(); // 핸들 → 버튼(라벨 조회용)

// Push-to-talk 상태 — Apple Speech STT 헬퍼(.app) 사용.
// 헬퍼는 서명된 앱이라 자체 마이크/음성인식 권한 보유 → Stream Deck 권한 문제/ffmpeg 노이즈 회피.
let recording = false;
let talkState = "hold"; // hold | ● REC | <실시간 텍스트> | mic err | STT err
let recPoll: ReturnType<typeof setInterval> | null = null;

async function startRecording(): Promise<void> {
  if (recording) return;
  recording = true;
  talkState = "● REC";
  renderAll();
  try {
    for (const f of [STT_TXT, STT_PID, STT_PARTIAL, STT_STATUS]) if (existsSync(f)) try { unlinkSync(f); } catch {}
    // open으로 실행 = LaunchServices/TCC가 번들 권한으로 라이브 인식 시작
    await execFileP("/usr/bin/open", [STT_APP]);
    // 말하는 동안 부분 인식결과를 다이얼에 실시간 표시 + 실패 원인 안내
    recPoll = setInterval(() => {
      try {
        if (existsSync(STT_STATUS)) {
          talkState = talkHint(readFileSync(STT_STATUS, "utf8").trim());
          recording = false;
          if (recPoll) { clearInterval(recPoll); recPoll = null; }
          renderAll();
          return;
        }
        const p = existsSync(STT_PARTIAL) ? readFileSync(STT_PARTIAL, "utf8").trim() : "";
        talkState = p || "● REC";
        renderAll();
      } catch {}
    }, 250);
  } catch (e) {
    streamDeck.logger.error(`stt start: ${e}`);
    recording = false;
    talkState = "mic err";
    renderAll();
  }
}

async function stopAndSend(target?: string): Promise<void> {
  if (!recording) return;
  recording = false;
  if (recPoll) { clearInterval(recPoll); recPoll = null; }
  talkState = "processing";
  renderAll();
  try {
    // 헬퍼 PID로 SIGINT → 인식 확정·결과 기록
    const pid = existsSync(STT_PID) ? readFileSync(STT_PID, "utf8").trim() : "";
    if (pid) try { await execFileP("/bin/kill", ["-INT", pid]); } catch {}
    // 결과 파일이 채워질 때까지 대기(최대 ~3s)
    let txt = "";
    for (let i = 0; i < 15; i++) {
      await new Promise((r) => setTimeout(r, 200));
      if (existsSync(STT_TXT)) {
        txt = readFileSync(STT_TXT, "utf8").trim();
        if (txt) break;
      }
    }
    // 인식이 비었고 실패 원인이 있으면 다이얼에 안내(받아쓰기/권한 등)
    if (!txt && existsSync(STT_STATUS)) {
      talkState = talkHint(readFileSync(STT_STATUS, "utf8").trim());
      renderAll();
      return;
    }
    let sent = false;
    let sendErr: string | null = null;
    if (txt && target) {
      try {
        await orcaRun(["terminal", "send", "--terminal", target, "--text", txt]);
        sent = true;
      } catch (e) {
        sendErr = String(e);
      }
    }
    try {
      writeFileSync("/tmp/agentdeck-talk.json", JSON.stringify({ at: new Date().toISOString(), txt, target: target ?? null, sent, sendErr }, null, 2));
    } catch {}
    talkState = "hold";
  } catch (e) {
    streamDeck.logger.error(`stt stop: ${e}`);
    talkState = "STT err";
  }
  renderAll();
}

// 대상 변경 시 pending을 그 세션의 적용값으로 리셋
function setTarget(h?: string): void {
  targetHandle = h;
  pendingModel = (h && modelByHandle.get(h)) || MODELS[0];
  pendingEffort = (h && effortByHandle.get(h)) || "medium";
}

type Coords = { column: number; row: number };
const slotViews = new Map<string, { action: any; coordinates?: Coords }>();
const dialViews = new Map<string, { action: any; role: string }>();
const lastImg = new Map<string, string>();

const slotIndex = (c?: Coords) => (c ? c.row * 4 + c.column : 0);

function ensureTarget(): string | undefined {
  if (!targetHandle || !allHandles.includes(targetHandle)) targetHandle = allHandles[0];
  return targetHandle;
}
function targetLabel(): string {
  const b = sessionByHandle.get(targetHandle ?? "");
  return b ? String(b.repo || b.label || "?") : "-";
}

function dialFeedback(role: string): { full: string } {
  ensureTarget();
  if (role === "model") return { full: dialImage("model", "MODEL", pendingModel, tick) };
  if (role === "effort") return { full: dialImage("effort", "EFFORT", pendingEffort, tick) };
  if (role === "talk") return { full: dialImage("talk", "TALK", talkState, tick) };
  return { full: dialImage("target", "TARGET", targetLabel(), tick) };
}

function renderAll(): void {
  const now = Date.now();
  const boardAttn = anyAttention(); // 주의 키가 하나라도 있으면 나머지는 dim으로 죽여 대비 강조
  for (const [id, { action: a, coordinates }] of slotViews) {
    const b = deck.slots[slotIndex(coordinates)] ?? { empty: true as const };
    const isTarget = !b.empty && (b as any).handle === targetHandle;
    const dim = boardAttn && !b.empty && !needsAttention(b, isTarget);
    const img = keyImage(b, tick, isTarget, now, dim);
    if (lastImg.get(id) === img) continue;
    lastImg.set(id, img);
    a.setImage(img).catch(() => {});
  }
  for (const { action: a, role } of dialViews.values()) {
    a.setFeedback(dialFeedback(role)).catch(() => {});
  }
}

// 화면에 보이는 키 중 주의 필요(펄스)한 게 하나라도 있나 — 펄스 루프 게이트(없으면 렌더 스킵).
function anyAttention(): boolean {
  for (const { coordinates } of slotViews.values()) {
    const b = deck.slots[slotIndex(coordinates)];
    if (b && !b.empty && needsAttention(b, (b as any).handle === targetHandle)) return true;
  }
  return false;
}

async function poll(): Promise<void> {
  try {
    const [tl, wp] = await Promise.all([orcaJson(["terminal", "list"]), orcaJson(["worktree", "ps"])]);
    deck = buildDeck(
      { terminals: tl.result?.terminals ?? [], worktrees: wp.result?.worktrees ?? [] },
      { page: currentPage, perPage: 8 },
    );
    if (currentPage >= deck.pageCount) currentPage = deck.pageCount - 1;
    // 전체 세션(사이드바 전부) 목록 유지 — 대상 다이얼이 8키 넘어서도 순회
    const full = buildDeck(
      { terminals: tl.result?.terminals ?? [], worktrees: wp.result?.worktrees ?? [] },
      { page: 0, perPage: 9999 },
    );
    allHandles = [];
    sessionByHandle.clear();
    for (const s of full.slots) {
      if (!s.empty) {
        allHandles.push((s as any).handle);
        sessionByHandle.set((s as any).handle, s);
      }
    }
    // 현재 포커스(활성) 세션을 대상으로 자동 지정 → 말하면 지금 보는 세션으로 감
    const activeWtId = (wp.result?.worktrees ?? []).find((w: any) => w.isActive)?.worktreeId;
    // 방금(1.8s 내) 다이얼/키로 수동 이동했으면 자동추적 억제 — 수동 선택이 poll에 밀리지 않게
    if (activeWtId && Date.now() - lastNav > 1800) {
      const terms = (tl.result?.terminals ?? []).filter((t: any) => t.worktreeId === activeWtId);
      const h = terms.sort((a: any, b: any) => (b.lastOutputAt ?? 0) - (a.lastOutputAt ?? 0))[0]?.handle;
      if (h && h !== targetHandle) setTarget(h);
    }
    renderAll();
    try {
      writeFileSync(
        "/tmp/agentdeck-debug.json",
        JSON.stringify({ at: new Date().toISOString(), total: deck.total, slotViews: slotViews.size, dialViews: dialViews.size, target: targetHandle, slots: deck.slots }, null, 2),
      );
    } catch {}
  } catch (e) {
    streamDeck.logger.error(`poll failed: ${e}`);
  }
}

@action({ UUID: "com.byjw.deep.slot" })
class SlotAction extends SingletonAction {
  override onWillAppear(ev: any): void {
    slotViews.set(ev.action.id, { action: ev.action, coordinates: ev.payload?.coordinates });
    renderAll();
  }
  override onWillDisappear(ev: any): void {
    slotViews.delete(ev.action.id);
    lastImg.delete(ev.action.id);
  }
  override async onKeyDown(ev: any): Promise<void> {
    const b: any = deck.slots[slotIndex(ev.payload?.coordinates)];
    if (b && !b.empty) {
      setTarget(b.handle); // 탭한 세션을 다이얼 대상으로(pending 모델도 그 세션값으로)
      lastNav = Date.now(); // 방금 수동 이동 → poll 자동추적 잠깐 억제
      try {
        await orcaRun(["terminal", "switch", "--terminal", b.handle]);
        await focusOrca(); // Orca가 백그라운드면 앞으로 + 그 세션으로 이동
      } catch (e) {
        streamDeck.logger.error(`switch failed: ${e}`);
        ev.action.showAlert?.();
      }
      renderAll();
    } else {
      ev.action.showAlert?.();
    }
  }
}

// 다이얼 공통 로직 — 역할(role)은 서브클래스가 고정
class DialBase extends SingletonAction {
  role = "model";
  override onWillAppear(ev: any): void {
    dialViews.set(ev.action.id, { action: ev.action, role: this.role });
    ev.action.setFeedback(dialFeedback(this.role)).catch(() => {});
  }
  override onWillDisappear(ev: any): void {
    dialViews.delete(ev.action.id);
  }
  override onDialRotate(ev: any): void {
    const dir = (ev.payload?.ticks ?? 0) > 0 ? 1 : (ev.payload?.ticks ?? 0) < 0 ? -1 : 0;
    if (!dir) return;
    const t = ensureTarget();
    if (this.role === "model") {
      pendingModel = MODELS[(MODELS.indexOf(pendingModel) + dir + MODELS.length) % MODELS.length];
    } else if (this.role === "effort") {
      pendingEffort = EFFORTS[(EFFORTS.indexOf(pendingEffort) + dir + EFFORTS.length) % EFFORTS.length];
    } else if (this.role === "target") {
      // 모든 세션 순회. 데크 코랄 점은 즉시 이동(setTarget+renderAll), 실제 Orca 전환은 디바운스(밀림 방지).
      if (allHandles.length) {
        const cur = allHandles.indexOf(t ?? allHandles[0]);
        const next = allHandles[(cur + dir + allHandles.length) % allHandles.length];
        lastNav = Date.now();
        setTarget(next);
        switchTargetSoon(next);
      }
    }
    // talk 회전(스크롤)은 orca 미지원 → no-op
    renderAll();
  }
  override async onDialDown(ev: any): Promise<void> {
    const t = ensureTarget();
    if (this.role === "model" && t) {
      modelByHandle.set(t, pendingModel);
      try {
        await orcaRun(["terminal", "send", "--terminal", t, "--text", `/model ${pendingModel}`, "--enter"]);
      } catch (e) {
        streamDeck.logger.error(`model apply: ${e}`);
        ev.action.showAlert?.();
      }
    } else if (this.role === "effort" && t) {
      effortByHandle.set(t, pendingEffort);
      try {
        await orcaRun(["terminal", "send", "--terminal", t, "--text", `/effort ${pendingEffort}`, "--enter"]);
      } catch (e) {
        streamDeck.logger.error(`effort apply: ${e}`);
        ev.action.showAlert?.();
      }
    } else if (this.role === "target" && t) {
      lastNav = Date.now();
      await orcaRun(["terminal", "switch", "--terminal", t]).catch(() => {});
      await focusOrca(); // 대상 다이얼 눌러 점프 시 Orca 앞으로
    } else if (this.role === "talk") {
      // 토글: 누르면 녹음 시작, 다시 누르면 정지·변환·전송
      // (hold 아님 — 녹음 시작 지연 때문에 짧게 누르면 거의 안 잡힘)
      if (recording) await stopAndSend(ensureTarget());
      else await startRecording();
    }
    renderAll();
  }
}

@action({ UUID: "com.byjw.deep.model" })
class ModelDial extends DialBase {
  role = "model";
}
@action({ UUID: "com.byjw.deep.effort" })
class EffortDial extends DialBase {
  role = "effort";
}
@action({ UUID: "com.byjw.deep.talk" })
class TalkDial extends DialBase {
  role = "talk";
}
@action({ UUID: "com.byjw.deep.target" })
class TargetDial extends DialBase {
  role = "target";
}

streamDeck.actions.registerAction(new SlotAction());
streamDeck.actions.registerAction(new ModelDial());
streamDeck.actions.registerAction(new EffortDial());
streamDeck.actions.registerAction(new TalkDial());
streamDeck.actions.registerAction(new TargetDial());
streamDeck.connect();

setInterval(poll, 1500);
setInterval(() => {
  tick++;
  renderAll();
}, 450);
// 주의 필요 키를 부드럽게 펄스(≈6fps, Elgato ≤10/s 준수). 주의 키 없으면 렌더 스킵.
setInterval(() => {
  if (anyAttention()) renderAll();
}, 160);
poll();
