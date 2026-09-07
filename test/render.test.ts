import { describe, it, expect } from "vitest";
import { keySvg, agentBadge, keyImage, wrap, stripSpinner, marqueeWindow, dialImage } from "../src/render.js";

describe("stripSpinner / wrap", () => {
  it("앞 스피너 글리프만 제거, 한글 보존", () => {
    expect(stripSpinner("⠂ 상한가 주식")).toBe("상한가 주식");
    expect(stripSpinner("정상 제목")).toBe("정상 제목");
  });
  it("wrap는 줄당 글자수·최대줄 지키고 넘치면 …", () => {
    expect(wrap("abcdefg", 7, 3)).toEqual(["abcdefg"]);
    const long = wrap("가".repeat(25), 7, 3); // 25 > 7*3 → 절단
    expect(long).toHaveLength(3);
    expect(long[2].endsWith("…")).toBe(true);
  });
});

describe("marqueeWindow", () => {
  it("창보다 짧으면 그대로", () => {
    expect(marqueeWindow("abc", 6, 0)).toBe("abc");
    expect(marqueeWindow("abc", 6, 5)).toBe("abc");
  });
  it("창보다 길면 tick마다 이동하고 창 크기 유지", () => {
    const s = "0123456789";
    expect([...marqueeWindow(s, 6, 0)]).toHaveLength(6);
    expect(marqueeWindow(s, 6, 0)).toBe("012345");
    expect(marqueeWindow(s, 6, 1)).toBe("123456");
    expect(marqueeWindow(s, 6, 2)).toBe("234567");
  });
  it("한 주기 뒤 처음으로 순환", () => {
    const s = "0123456789";
    const period = [...`${s}   ·   `].length; // 구현과 동일한 주기
    expect(marqueeWindow(s, 6, period)).toBe(marqueeWindow(s, 6, 0));
  });
});

describe("keySvg", () => {
  it("빈 칸은 어두운 배경", () => {
    expect(keySvg({ empty: true })).toContain("#141416");
  });
  it("상단 색 띠 + 프로젝트명(가운데) + 브랜치-번호, 상태워드·세션제목은 안 씀", () => {
    const svg = keySvg({
      empty: false, handle: "term_x", label: "세션제목무시됨",
      state: "working", color: "blue", repo: "svd", branch: "main", dupIndex: 1,
    });
    expect(svg).toContain("#3b82f6"); // 상단 색 띠(blue)
    expect(svg).not.toContain("WORKING"); // 상태 단어 제거
    expect(svg).toContain("svd"); // 프로젝트명
    expect(svg).toContain("main-1"); // 브랜치-번호
    expect(svg).not.toContain("세션제목무시됨");
  });

  it("대상이면 우측 상단 코랄 점(dot), 비대상은 없음", () => {
    const b = { empty: false as const, handle: "t", label: "x", state: "done", color: "green" as const, repo: "svd", branch: "main" };
    const on = keySvg(b, 0, true);
    const off = keySvg(b, 0, false);
    expect(on).toContain('<circle cx="124" cy="32" r="10" fill="#d97757"'); // 우측 상단 코랄 점
    expect(on).toContain("main"); // 브랜치는 일반 텍스트 유지
    expect(on).toContain('fill="#ffffff"'); // 이름은 흰색
    expect(off).not.toContain("#d97757");
  });
});

describe("agentBadge — 타일마다 에이전트 뱃지(2글자 알약)", () => {
  it("알려진 타입은 2글자 + 컬러 배경", () => {
    expect(agentBadge("claude")).toContain('fill="#d97757"'); // CL 오렌지
    expect(agentBadge("claude")).toContain(">CL</text>");
    expect(agentBadge("opencode")).toContain('fill="#10b981"');
    expect(agentBadge("opencode")).toContain(">OC</text>");
    expect(agentBadge("codex")).toContain('fill="#a78bfa"');
    expect(agentBadge("codex")).toContain(">CX</text>");
    expect(agentBadge("agy")).toContain('fill="#3b82f6"');
    expect(agentBadge("agy")).toContain(">AG</text>");
  });
  it("대소문자 무시", () => {
    expect(agentBadge("OpenCode")).toContain(">OC</text>");
    expect(agentBadge("Claude")).toContain(">CL</text>");
  });
  it("모르는 타입은 회색 알약 + 앞 2글자, 없으면 물음표", () => {
    const g = agentBadge("grok");
    expect(g).toContain('fill="#4b5563"');
    expect(g).toContain(">GR</text>");
    expect(agentBadge(undefined)).toContain(">?</text>");
    expect(agentBadge(null)).toContain(">?</text>");
  });
  it("keySvg에 타일마다 뱃지가 들어간다", () => {
    const svg = keySvg({ empty: false as const, handle: "t", label: "x", state: "working", color: "blue" as const, repo: "svd", branch: "main", agentType: "opencode" });
    expect(svg).toContain(">OC</text>");
    expect(svg).toContain('fill="#10b981"');
  });
  it("빈 칸은 뱃지 없음", () => {
    expect(keySvg({ empty: true })).not.toContain("</text>");
  });
});

describe("keySvg 주의 애니메이션(펄스 링)", () => {
  const attn = { empty: false as const, handle: "t", label: "x", state: "waiting", color: "amber" as const, repo: "svd", branch: "main" };
  const calm = { empty: false as const, handle: "t", label: "x", state: "working", color: "blue" as const, repo: "svd", branch: "main" };
  it("주의 키는 nowMs에 따라 SVG가 달라진다(애니메이션)", () => {
    expect(keySvg(attn, 0, false, 0)).not.toBe(keySvg(attn, 0, false, 320));
  });
  it("정적(작업중) 키는 nowMs 무관하게 동일(캐시 안정)", () => {
    expect(keySvg(calm, 0, false, 0)).toBe(keySvg(calm, 0, false, 999));
  });
  it("현재 보는 세션(target)의 완료(green)는 이미 보고 있어 애니메이션 안 함(정적)", () => {
    const done = { empty: false as const, handle: "t", label: "x", state: "done", color: "green" as const, repo: "svd", branch: "main" };
    expect(keySvg(done, 0, true, 0)).toBe(keySvg(done, 0, true, 500));
  });
  it("현재 보는 세션(target)이라도 입력대기(amber)는 승인/입력 필요로 애니메이션 유지", () => {
    expect(keySvg(attn, 0, true, 0)).not.toBe(keySvg(attn, 0, true, 320));
  });
  it("주의 키는 배경이 상태색으로 펄스(글로우 오버레이 — 상태띠 포함 최소 2개 fill)", () => {
    // amber 주의 키: 배경 글로우 + 상태띠 = #f59e0b fill 2개 이상
    expect((keySvg(attn, 0, false, 200).match(/#f59e0b/g) || []).length).toBeGreaterThanOrEqual(2);
    // 비주의(파랑) 키는 상태띠 1개뿐(글로우 없음)
    expect((keySvg(calm, 0, false, 200).match(/#3b82f6/g) || []).length).toBe(1);
  });
});

describe("keySvg dim — 주의 없는 키 죽여 대비 만들기", () => {
  const calm = { empty: false as const, handle: "t", label: "x", state: "working", color: "blue" as const, repo: "svd", branch: "main" };
  it("dim이면 키 전체를 어둡게(그룹 opacity)", () => {
    expect(keySvg(calm, 0, false, 0, true)).toContain('opacity="0.32"');
  });
  it("dim 아니면 정상 밝기(죽이지 않음)", () => {
    expect(keySvg(calm, 0, false, 0, false)).not.toContain('opacity="0.32"');
  });
});

describe("keyImage — 키는 SVG data URI로 내보낸다(글자 뱃지라 PNG/raster 불필요)", () => {
  it("SVG를 base64 data URI로 반환", () => {
    const img = keyImage({ empty: false as const, handle: "t", label: "x", state: "working", color: "blue" as const, repo: "svd", branch: "main", agentType: "opencode" });
    expect(img.startsWith("data:image/svg+xml;base64,")).toBe(true);
    const svg = Buffer.from(img.split(",")[1], "base64").toString("utf8");
    expect(svg).toContain("<svg");
    expect(svg).toContain(">OC</text>");
  });
  it("빈 칸도 SVG data URI", () => {
    expect(keyImage({ empty: true })).toMatch(/^data:image\/svg\+xml;base64,/);
  });
});

describe("dialImage — 다이얼 렌더", () => {
  it("렌더 throw 없이 data URI 반환 (한 줄 값)", () => {
    const img = dialImage("model", "MODEL", "opus", 0);
    expect(img.startsWith("data:image/svg+xml;base64,")).toBe(true);
  });
  it("짧은 값은 한 줄 텍스트, 줄당 글자수는 가용 폭(narrow) 기준", () => {
    const svg = Buffer.from(dialImage("effort", "EFFORT", "high", 0).split(",")[1], "base64").toString("utf8");
    expect(svg.match(/<text/g) || []).toHaveLength(2); // label + value (한 줄)
    expect(svg).toContain('font-size="28"');
  });
  it("긴 값은 가용 폭 기준으로 3줄 래핑(모델 라벨 소형)", () => {
    const long = "opencode/claude-opus-4-6-preview-2025-nerf-extra-long";
    const svg = Buffer.from(dialImage("model", "MODEL", long, 0).split(",")[1], "base64").toString("utf8");
    expect(svg).toContain('font-size="11"'); // model label small
    const lines = svg.match(/y="[0-9]+"/g) || [];
    expect(lines.length).toBe(4); // label + 3 value lines
    expect(svg).toContain("opencode"); // provider survives full-width wrap
    expect(svg).toContain("claude-opus"); // model slug survives full-width wrap (not 8-char)
  });
  it("한 줄에 못 들어가는 값은 '/' 경계에서 줄바꿈(마지막 글자 잘림 방지)", () => {
    const v = "minimax/minimax-m3";
    const svg = Buffer.from(dialImage("model", "MODEL", v, 0).split(",")[1], "base64").toString("utf8");
    const textY = [...svg.matchAll(/text x="18" y="(\d+)"/g)].map((m) => m[1]);
    expect(textY.length).toBeGreaterThan(1); // 2줄 이상
    expect(svg).toContain(">minimax</text>");
    expect(svg).toContain(">minimax-m3</text>");
  });
  it("disabled=true인 다이얼은 레일/라벨/값이 어두운 회색이고 투명도 그룹 포함", () => {
    const svg = Buffer.from(dialImage("effort", "EFFORT", "-", 0, true).split(",")[1], "base64").toString("utf8");
    expect(svg).toContain('fill="#2e2e34"'); // 어두운 레일
    expect(svg).toContain('fill="#4a4a52"'); // 흐린 라벨 및 값
    expect(svg).toContain('<g opacity="0.38">'); // 투명도 딤
  });
  it("badge를 주면 우상단에 에이전트 알약이 그려진다(대상 다이얼)", () => {
    const svg = Buffer.from(dialImage("target", "TARGET", "svd", 0, false, "opencode", "main").split(",")[1], "base64").toString("utf8");
    expect(svg).toContain('fill="#10b981"'); // opencode 초록
    expect(svg).toContain(">OC</text>");
    expect(svg).toContain('x="166" y="6"');
  });
  it("sub(브랜치)를 주면 값 아래 작은 줄로 그린다", () => {
    const svg = Buffer.from(dialImage("target", "TARGET", "svd", 0, false, "opencode", "main").split(",")[1], "base64").toString("utf8");
    expect(svg).toContain('fill="#b8b8be"'); // 브랜치 흐린 회색
    expect(svg).toContain(">main</text>");
    expect(svg).toContain('font-size="13" font-weight="600"');
  });
  it("badge 없으면 우상단 알약 없음", () => {
    const svg = Buffer.from(dialImage("target", "TARGET", "svd", 0).split(",")[1], "base64").toString("utf8");
    expect(svg).not.toContain('x="166" y="6"');
  });
});
