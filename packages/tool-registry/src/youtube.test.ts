import { describe, expect, it } from "vitest";
import {
  assertYoutubeUrl,
  cleanVttTranscript,
  extractVideoId,
  mergeRollingCues,
  parseYoutubeSearchOutput,
} from "./builtin/youtube.js";

describe("youtube · URLs", () => {
  it("acepta las URLs de YouTube y las normaliza", () => {
    expect(assertYoutubeUrl("https://www.youtube.com/watch?v=abc12345678")).toContain("youtube.com");
    expect(assertYoutubeUrl("youtu.be/abc12345678")).toContain("youtu.be");
    expect(assertYoutubeUrl("youtube.com/watch?v=abc12345678")).toContain("https://");
  });

  it("rechaza cualquier otra cosa (no es un atajo a ficheros ni a la red interna)", () => {
    for (const candidate of [
      "http://127.0.0.1:5432/",
      "file:///etc/passwd",
      "http://169.254.169.254/latest/meta-data/",
      "https://evil.example/watch?v=abc",
      "https://youtube.com.evil.example/watch?v=abc",
    ]) {
      expect(() => assertYoutubeUrl(candidate), candidate).toThrow(/YouTube|no válida/);
    }
  });

  it("saca el identificador del vídeo de las distintas formas de URL", () => {
    expect(extractVideoId("https://www.youtube.com/watch?v=abc12345678")).toBe("abc12345678");
    expect(extractVideoId("https://youtu.be/abc12345678")).toBe("abc12345678");
    expect(extractVideoId("https://www.youtube.com/shorts/abc12345678")).toBe("abc12345678");
    expect(extractVideoId("https://www.youtube.com/live/abc12345678")).toBe("abc12345678");
    expect(extractVideoId("https://example.com")).toBe("");
  });
});

describe("youtube · lectura de la salida del buscador", () => {
  it("normaliza las líneas JSON de yt-dlp", () => {
    const stdout = [
      '{"id":"abc12345678","title":"Cómo crear agentes","webpage_url":"https://www.youtube.com/watch?v=abc12345678","uploader":"Canal","duration":600,"description":"Un tutorial"}',
      '{"id":"def12345678","title":"Otro vídeo","webpage_url":"https://youtu.be/def12345678","channel":"Otro canal"}',
      "línea que no es JSON",
      "",
    ].join("\n");
    const videos = parseYoutubeSearchOutput(stdout);
    expect(videos).toHaveLength(2);
    expect(videos[0]).toMatchObject({
      id: "abc12345678",
      title: "Cómo crear agentes",
      channel: "Canal",
      durationSeconds: 600,
    });
    expect(videos[1]?.durationSeconds).toBeUndefined();
    expect(videos[1]?.channel).toBe("Otro canal");
  });
});

describe("youtube · limpieza de subtítulos", () => {
  it("quita las marcas de karaoke y las marcas de tiempo", () => {
    const vtt = [
      "WEBVTT",
      "Kind: captions",
      "Language: es",
      "",
      "00:00:00.599 --> 00:00:03.470 align:start position:0%",
      "Agentes<00:00:00.960><c> de</c><00:00:01.120><c> IA,</c> los<TIMESTAMP> mejores",
      "",
    ].join("\n");
    const text = cleanVttTranscript(vtt);
    expect(text).toBe("Agentes de IA, los mejores");
    expect(text).not.toContain("<");
    expect(text).not.toContain("00:00");
  });

  it("elimina el solapamiento de los bloques que se repiten", () => {
    const cues = [
      "Agentes de IA, agentes de IA, agentes de",
      "Agentes de IA, agentes de IA, agentes de",
      "IA. Están en boca de todos",
      "Están en boca de todos y es por una razón",
    ];
    expect(mergeRollingCues(cues)).toBe("Agentes de IA, agentes de IA, agentes de IA. Están en boca de todos y es por una razón");
  });

  it("deja el texto intacto cuando no hay repeticiones", () => {
    expect(mergeRollingCues(["Hola", "que tal", "bien"])).toBe("Hola que tal bien");
  });

  it("decodifica las entidades", () => {
    const vtt = ["WEBVTT", "", "00:00:00.000 --> 00:00:01.000", "Tom & Jerry <3"].join("\n");
    expect(cleanVttTranscript(vtt)).toBe("Tom & Jerry <3");
  });
});
