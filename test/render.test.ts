import { describe, it, expect } from "vitest";
import { keySvg, wrap, stripSpinner, marqueeWindow } from "../src/render.js";

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

describe("keySvg 주의 애니메이션(펄스 링)", () => {
  const attn = { empty: false as const, handle: "t", label: "x", state: "waiting", color: "amber" as const, repo: "svd", branch: "main" };
  const calm = { empty: false as const, handle: "t", label: "x", state: "working", color: "blue" as const, repo: "svd", branch: "main" };
  it("주의 키는 nowMs에 따라 SVG가 달라진다(애니메이션)", () => {
    expect(keySvg(attn, 0, false, 0)).not.toBe(keySvg(attn, 0, false, 320));
  });
  it("정적(작업중) 키는 nowMs 무관하게 동일(캐시 안정)", () => {
    expect(keySvg(calm, 0, false, 0)).toBe(keySvg(calm, 0, false, 999));
  });
  it("현재 보는 세션(target)은 애니메이션 안 함(정적)", () => {
    expect(keySvg(attn, 0, true, 0)).toBe(keySvg(attn, 0, true, 500));
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
