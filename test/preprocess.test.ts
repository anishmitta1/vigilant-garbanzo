import { describe, expect, it } from "vitest";
import { canonicalUrl, normalize, stripHtml, titleFingerprint } from "../src/preprocess.js";

describe("preprocess", () => {
  it("strips html and decodes entities", () => {
    expect(stripHtml("<p>A &amp; B</p>\n  <b>c</b>")).toBe("A & B c");
  });

  it("canonicalizes urls", () => {
    expect(canonicalUrl("https://WWW.Example.com/a/?utm_source=x&b=2&a=1#frag")).toBe("https://example.com/a?a=1&b=2");
    expect(canonicalUrl("javascript:alert(1)")).toBeNull();
    expect(canonicalUrl("nope")).toBeNull();
  });

  it("fingerprints syndicated titles the same", () => {
    expect(titleFingerprint("Fed cuts rates by 25 bps - Reuters")).toBe(titleFingerprint("Fed cuts rates by 25 bps"));
  });

  it("normalizes items and drops empty titles", () => {
    expect(normalize("s", { externalId: "1", title: "  " })).toBeNull();
    const o = normalize("s", { externalId: "", title: "Hi", url: "https://a.com/x?fbclid=1", publishedAt: "Mon, 05 Oct 2026 14:00:00 GMT" });
    expect(o).toMatchObject({ externalId: "https://a.com/x", url: "https://a.com/x", publishedAt: "2026-10-05T14:00:00.000Z" });
  });
});
