import { useCallback, useEffect, useRef, useState } from "react";

export interface CameraController {
  videoRef: React.RefObject<HTMLVideoElement>;
  active: boolean;
  starting: boolean;
  error: string | null;
  start: () => Promise<void>;
  stop: () => void;
  capture: () => { dataUrl: string; width: number; height: number } | null;
}

/**
 * Camera access is always explicit: nothing turns the camera on implicitly and
 * every stream is released when the user disables the panel.
 */
export function useCamera(allowed: boolean): CameraController {
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const [active, setActive] = useState(false);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const stop = useCallback(() => {
    const stream = streamRef.current;
    if (stream) stream.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    if (videoRef.current) videoRef.current.srcObject = null;
    setActive(false);
    setStarting(false);
  }, []);

  const start = useCallback(async () => {
    if (!allowed) {
      setError("La cámara está deshabilitada en los ajustes.");
      return;
    }
    if (streamRef.current) return;
    setStarting(true);
    setError(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { width: { ideal: 1280 }, height: { ideal: 720 } },
        audio: false,
      });
      streamRef.current = stream;
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        await videoRef.current.play().catch(() => undefined);
      }
      setActive(true);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "No se pudo acceder a la cámara");
      setActive(false);
    } finally {
      setStarting(false);
    }
  }, [allowed]);

  const capture = useCallback((): { dataUrl: string; width: number; height: number } | null => {
    const video = videoRef.current;
    if (!video || video.videoWidth === 0) return null;
    const maxWidth = 960;
    const scale = Math.min(1, maxWidth / video.videoWidth);
    const width = Math.round(video.videoWidth * scale);
    const height = Math.round(video.videoHeight * scale);
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d");
    if (!context) return null;
    context.drawImage(video, 0, 0, width, height);
    return { dataUrl: canvas.toDataURL("image/jpeg", 0.82), width, height };
  }, []);

  useEffect(() => {
    if (!allowed && streamRef.current) stop();
  }, [allowed, stop]);

  useEffect(() => () => stop(), [stop]);

  return { videoRef, active, starting, error, start, stop, capture };
}
