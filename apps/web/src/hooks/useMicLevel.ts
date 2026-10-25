import { useEffect, useState } from "react";
import { getAudioFrame, retainAudio } from "../lib/audioEngine";

const UPDATE_INTERVAL_MS = 60;

/** Loudness (0..1) of the microphone, shared through the audio engine. */
export function useMicLevel(active: boolean): number {
  const [level, setLevel] = useState(0);

  useEffect(() => {
    if (!active) {
      setLevel(0);
      return;
    }

    const release = retainAudio();
    let last = 0;
    const timer = window.setInterval(() => {
      const now = performance.now();
      if (now - last < UPDATE_INTERVAL_MS) return;
      last = now;
      setLevel(getAudioFrame().level);
    }, UPDATE_INTERVAL_MS);

    return () => {
      window.clearInterval(timer);
      release();
      setLevel(0);
    };
  }, [active]);

  return level;
}
