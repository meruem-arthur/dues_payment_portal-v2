import { describe, it, expect } from "vitest";
import { safeCell } from "./student-export";

describe("safeCell (spreadsheet formula injection guard)", () => {
  it("neutralises formula starters", () => {
    expect(safeCell('=HYPERLINK("http://evil")')).toBe(`'=HYPERLINK("http://evil")`);
    expect(safeCell("@SUM(1)")).toBe("'@SUM(1)");
    expect(safeCell("+cmd|' /C calc'!A0")).toMatch(/^'/);
    expect(safeCell("-2+3+cmd")).toMatch(/^'/);
  });
  it("leaves normal values and real phone numbers alone", () => {
    expect(safeCell("Ama Serwaa")).toBe("Ama Serwaa");
    expect(safeCell("0551234567")).toBe("0551234567");
    expect(safeCell("+233 55 123 4567")).toBe("+233 55 123 4567");
    expect(safeCell(null)).toBe("");
  });
});
