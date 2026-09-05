# Deep

> **English:** [README.en.md](README.en.md)

**Stream Deck Plus로 [Orca](https://orca.computer) 위에서 도는 Claude(및 호환 에이전트) 세션을 지휘하는 물리 컨트롤 서피스.**

여러 에이전트를 bypass로 동시에 돌릴 때, 창을 왔다갔다 안 하고 **8칸 상태판**으로 보고 · 눌러서 점프 · 다이얼로 모델/Effort 바꾸고 · **음성으로 지시**한다. OpenAI Codex Micro 컨셉을 Stream Deck으로.

---

## 요구 사항
| | |
|---|---|
| **macOS** | 필수 (STT·권한·오디오가 macOS 전용) |
| **[Orca](https://orca.computer)** | 필수 — 세션 목록·상태·전환·전송이 전부 `orca` CLI 기반 |
| **Node.js** | 필수 — 시스템 node로 실행 (homebrew/local/nvm 자동 탐색) |
| **Stream Deck +** | 8키 + 4다이얼 모델 (다이얼 기능은 + 전용) |
| 에이전트 | Claude Code 권장. 세션판·Talk는 어떤 Orca 에이전트든, **모델·Effort 다이얼은 `/model`·`/effort` 쓰는 에이전트**(Claude 등) |

## 다운로드 · 설치 (사용자)
1. [Releases](https://github.com/Jungwoon/deep/releases)에서 최신 `com.byjw.deep.streamDeckPlugin` 다운로드
2. 파일 **더블클릭** → Stream Deck 앱 설치창 → 설치
3. Stream Deck 앱 오른쪽 **Deep** 카테고리 확인 → 아래 [액션 배치](#액션-배치-stream-deck-앱)대로 키·다이얼에 드래그

> 음성(STT) 헬퍼는 Apple 공증(notarized)돼 Gatekeeper 경고 없이 실행됩니다.

## 소스에서 빌드 (개발)
```bash
git clone https://github.com/Jungwoon/deep && cd deep
npm install
npm run package                              # 아이콘 + esbuild 번들
npx streamdeck link com.byjw.deep.sdPlugin
# 새 플러그인은 Stream Deck 앱 startup에 스캔 → 앱 1회 재시작
```

## 액션 배치 (Stream Deck 앱)
- **키 탭** → 오른쪽 **Deep** 카테고리 → **Session Slot**을 **키 8칸에** 드래그(슬롯=좌표 자동, 설정 불필요)
- **다이얼 탭** → 다이얼에 각각 드래그: **모델 / Effort / Talk / 대상 세션 선택**

## 사용법
### 키 (세션판)
| 요소 | 의미 |
|---|---|
| **상단 색 띠** | 🔵 working · 🟡 waiting(입력대기) · 🟢 done · 🔴 error · ⚪ idle |
| **가운데 흰 글자** | 프로젝트명 (경로에서 추출, 예: `AcmeApp`) |
| **아래** | 브랜치. **현재 보는 세션은 코랄 칩**으로 강조 |
| **탭** | 그 세션으로 포커스(`orca terminal switch`) |
| **초록 완료 색** | done + 안 읽음 = 초록(확인 필요), 열어보면 흰색(idle) |

### 다이얼
| 다이얼 | 돌리기 | 누르기 |
|---|---|---|
| **모델** | opus↔sonnet↔haiku 고르기 | 현재 세션에 `/model` 적용 |
| **Effort** | low↔…↔ultracode 고르기 | 현재 세션에 `/effort` 적용 |
| **Talk** | — | 눌러 녹음 시작 → 말하고 → 다시 눌러 정지·전송(토글) |
| **대상 세션 선택** | 모든 세션 순회(포커스 이동) | 그 세션으로 점프 |

> 다이얼은 **지금 보고 있는(포커스된) 세션**에 작용한다. 코랄 칩이 대상 표시.

## 🎤 Talk (음성 입력) 설정 — 처음 한 번
Talk는 **macOS 온디바이스 음성인식**을 쓴다. 다음이 필요:
1. **받아쓰기 켜기**: 시스템 설정 → 키보드 → **받아쓰기 On**
2. **권한 허용**: 처음 Talk 누르면 **마이크**·**음성 인식** 권한 프롬프트 → 허용
3. 입력 장치가 실제 마이크인지 확인(시스템 설정 → 소리 → 입력)

인식 언어는 **시스템 받아쓰기 언어**를 자동으로 따릅니다(한국어 고정 아님). 특정 언어로 강제하려면 플러그인 bin 폴더에서 `STT_LOCALE`(예: `en-US`) 환경변수 또는 `/tmp/agentdeck-stt.locale` 파일에 로케일을 지정하세요.

문제가 있으면 **Talk 다이얼에 원인이 표시**된다: `받아쓰기 켜기` / `마이크 권한 켜기` / `음성인식 권한 켜기`.

## 한계
- **Mac + Orca 전용**. 다른 터미널·OS 미지원.
- **키는 8칸(1페이지)**. 세션 8개 초과 시 9번째+는 키에 안 보이지만 **대상 다이얼로 접근 가능**.
- 모델·Effort 프리셋은 Claude 기준(다른 에이전트는 이름 다름).

## 개발
```bash
npm test          # 코어 유닛테스트(Vitest)
npm run build     # esbuild → com.byjw.deep.sdPlugin/bin/plugin.js
npm run poll      # 실제 orca 세션을 콘솔 상태판으로 미리보기
# STT 헬퍼(Swift): swiftc src/stt-helper.swift → .app 번들, Developer ID 서명 필요
```
- **Node 실행**: Elgato 관리형 Node 대신 `bin/launch.sh`가 시스템 node로 실행(런타임 미설치 우회).
- **STT**: 서명된 `.app` 번들이라야 macOS TCC가 마이크/음성인식 usage description 신뢰. 배포엔 **notarization** 필요.
- 디버그: `/tmp/agentdeck-*.json`·`.log`(폴링 상태·인식결과·실패코드).
