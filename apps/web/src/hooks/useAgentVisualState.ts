import { useEffect, useMemo, useRef, useState } from "react";
import type { AgentState } from "../lib/events";

export interface AgentVisualState {
  state: AgentState;
  color: string;
  secondaryColor: string;
  spin: number;
  counterSpin: number;
  pulseAmplitude: number;
  pulseFrequency: number;
  particleSpeed: number;
  particleOpacity: number;
  coreGlow: number;
  failure: boolean;
}

function useRafSmoothedValue(value: number, reducedMotion: boolean, intervalMs: number): number {
  const [smoothed, setSmoothed] = useState(value);
  const targetRef = useRef(value);
  const lastRef = useRef(0);

  useEffect(() => {
    targetRef.current = value;
  }, [value]);

  useEffect(() => {
    if (reducedMotion) {
      setSmoothed(targetRef.current);
      return;
    }
    let frame = 0;
    const tick = (timestamp: number) => {
      if (timestamp - lastRef.current > intervalMs) {
        lastRef.current = timestamp;
        setSmoothed((previous) => previous + (targetRef.current - previous) * 0.4);
      }
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [reducedMotion, intervalMs]);

  return smoothed;
}

export function useAgentVisualState(
  state: AgentState | null,
  micLevel: number,
  ttsSpeaking: boolean,
  reducedMotion: boolean,
): AgentVisualState {
  const mic = useRafSmoothedValue(micLevel, reducedMotion, 70);
  const [completedSettled, setCompletedSettled] = useState(false);

  useEffect(() => {
    if (state !== "COMPLETED") {
      setCompletedSettled(false);
      return;
    }
    const timer = window.setTimeout(() => setCompletedSettled(true), 1600);
    return () => window.clearTimeout(timer);
  }, [state]);

  return useMemo<AgentVisualState>(() => {
    const resolved: AgentState = state ?? "IDLE";
    const base: AgentVisualState = {
      state: resolved,
      color: "#0077ff",
      secondaryColor: "#4da6ff",
      spin: 0.06,
      counterSpin: -0.03,
      pulseAmplitude: 0.02,
      pulseFrequency: 0.4,
      particleSpeed: 0.015,
      particleOpacity: 0.35,
      coreGlow: 0.8,
      failure: false,
    };

    if (reducedMotion) {
      return {
        ...base,
        spin: 0,
        counterSpin: 0,
        pulseAmplitude: 0,
        particleSpeed: 0,
        particleOpacity: resolved === "IDLE" ? 0.2 : 0.3,
        failure: resolved === "FAILED",
        color: resolved === "FAILED" ? "#ff1100" : base.color,
      };
    }

    switch (resolved) {
      case "LISTENING":
        return {
          ...base,
          color: "#00f0ff",
          spin: 0.14,
          counterSpin: -0.09,
          pulseAmplitude: 0.05 + mic * 0.3,
          pulseFrequency: 1.6 + mic * 2.4,
          particleSpeed: 0.05,
          particleOpacity: 0.55,
        };
      case "UNDERSTANDING":
        return {
          ...base,
          color: "#ff8800",
          spin: 0.22,
          counterSpin: -0.12,
          pulseAmplitude: 0.04,
          pulseFrequency: 1.1,
          particleOpacity: 0.5,
        };
      case "PLANNING":
        return {
          ...base,
          color: "#ff8800",
          spin: 0.55,
          counterSpin: -0.42,
          pulseAmplitude: 0.05,
          pulseFrequency: 2.2,
          particleSpeed: 0.09,
          particleOpacity: 0.6,
        };
      case "WAITING_FOR_APPROVAL":
        return {
          ...base,
          color: "#ffaa00",
          secondaryColor: "#c47f00",
          spin: 0.1,
          counterSpin: -0.06,
          pulseAmplitude: 0.05,
          pulseFrequency: 1.2,
          particleOpacity: 0.45,
        };
      case "EXECUTING":
        return {
          ...base,
          color: "#ff8800",
          spin: 0.34,
          counterSpin: 0.24,
          pulseAmplitude: 0.05,
          pulseFrequency: 1.8,
          particleSpeed: 0.1,
          particleOpacity: 0.7,
          coreGlow: 1.25,
        };
      case "SPEAKING":
        return {
          ...base,
          color: "#ff8800",
          spin: 0.18,
          counterSpin: -0.14,
          pulseAmplitude: ttsSpeaking ? 0.14 : 0.06,
          pulseFrequency: 3.4,
          particleSpeed: 0.07,
          particleOpacity: 0.6,
          coreGlow: 1.15,
        };
      case "INTERRUPTED":
        return {
          ...base,
          color: "#0077ff",
          secondaryColor: "#1e3a8a",
          spin: 0,
          counterSpin: 0,
          pulseAmplitude: 0,
          pulseFrequency: 0.3,
          particleSpeed: 0,
          particleOpacity: 0.18,
          coreGlow: 0.35,
        };
      case "FAILED":
        return {
          ...base,
          color: "#ff1100",
          secondaryColor: "#7f0d06",
          spin: 0,
          counterSpin: 0,
          pulseAmplitude: 0.01,
          pulseFrequency: 5.5,
          particleSpeed: 0,
          particleOpacity: 0.25,
          coreGlow: 0.6,
          failure: true,
        };
      case "COMPLETED":
        if (completedSettled) {
          return { ...base, dimmed: true };
        }
        return {
          ...base,
          color: "#ff8800",
          spin: 0.5,
          counterSpin: -0.3,
          pulseAmplitude: 0.06,
          pulseFrequency: 2.4,
          particleSpeed: 0.08,
          particleOpacity: 0.65,
        };
      case "IDLE":
      default:
        return { ...base, dimmed: true };
    }
  }, [state, mic, ttsSpeaking, reducedMotion, completedSettled]);
}
