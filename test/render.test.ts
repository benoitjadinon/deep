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

  it("대상이면 브랜치가 코랄 칩(비대상은 회색 텍스트)", () => {
    const b = { empty: false as const, handle: "t", label: "x", state: "done", color: "green" as const, repo: "svd", branch: "main" };
    const on = keySvg(b, 0, true);
    const off = keySvg(b, 0, false);
    expect(on).toContain('fill="#d97757"'); // 코랄 칩
    expect(on).toContain("main");
    expect(off).not.toContain("#d97757");
  });
});
