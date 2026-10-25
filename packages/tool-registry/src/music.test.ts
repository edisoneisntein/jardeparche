import { describe, expect, it } from "vitest";
import { assertMediaUrl, musicScript } from "./builtin/music.js";

describe("music · URLs de medios", () => {
  it("acepta http y https", () => {
    expect(assertMediaUrl("https://www.youtube.com/watch?v=abc12345678")).toContain("youtube.com");
    expect(assertMediaUrl("http://example.com/audio.mp3")).toContain("example.com");
  });

  it("rechaza ficheros locales, apps y esquemas raros", () => {
    for (const candidate of [
      "file:///etc/passwd",
      "smb://192.168.1.10/share/song.mp3",
      "ssh://localhost/home/user",
      "javascript:alert(1)",
      "not a url",
    ]) {
      expect(() => assertMediaUrl(candidate), candidate).toThrow();
    }
  });
});

describe("music · control del reproductor", () => {
  it("construye el guion de AppleScript correcto", () => {
    expect(musicScript("pause")).toContain('to pause');
    expect(musicScript("resume")).toContain('to play');
    expect(musicScript("stop")).toContain('to stop');
  });
});
