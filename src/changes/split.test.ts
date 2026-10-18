import { describe, expect, it } from "vitest";
import type { DiffLine } from "../api";
import { splitRows } from "./split";

const ctx = (text: string): DiffLine => ({ kind: "context", oldLine: 1, newLine: 1, text });
const del = (text: string): DiffLine => ({ kind: "removed", oldLine: 1, newLine: null, text });
const add = (text: string): DiffLine => ({ kind: "added", oldLine: null, newLine: 1, text });

const texts = (lines: DiffLine[]) =>
  splitRows(lines).map((r) => `${r.left?.text ?? "·"}|${r.right?.text ?? "·"}`);

describe("splitRows", () => {
  it("pairs removals with the additions that replace them", () => {
    expect(texts([ctx("a"), del("b"), del("c"), add("B"), ctx("d")])).toEqual(["a|a", "b|B", "c|·", "d|d"]);
  });

  it("puts pure additions and removals against blanks", () => {
    expect(texts([add("x"), add("y")])).toEqual(["·|x", "·|y"]);
    expect(texts([del("x")])).toEqual(["x|·"]);
  });

  it("keeps separate change blocks apart", () => {
    expect(texts([del("a"), add("A"), del("b"), add("B")])).toEqual(["a|A", "b|B"]);
    expect(texts([add("A"), del("b")])).toEqual(["·|A", "b|·"]);
  });
});
