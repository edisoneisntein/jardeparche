import { useCallback, useEffect, useRef } from "react";
import { API_BASE } from "../api/client";
import { useJarvisStore } from "../state/jarvisStore";
import type { HealthReport } from "../lib/events";

/**
 * PERF-001 · Salud por streaming (SSE) en lugar de sondeo.
 *
 * Antes este hook abría una petición HTTP cada 30 segundos: con el HUD
 * abierto eran 2 peticiones por minuto por pestaña, y cada una devolvía el
 * informe COMPLETO aunque nada hubiera cambiado.
 *
 * Ahora el navegador mantiene una sola conexión `EventSource` abierta contra
 * `/api/health/stream` y recibe el informe por el canal. Si la conexión se
 * cae, se reintenta con espera exponencial (nunca más rápido que 1 s) y sin
 * dejar conexiones huérfanas al desmontar.
 */

/** Espera inicial tras una desconexión. */
const RECONNECT_MIN_MS = 1_000;
/** Tope de la espera exponencial. */
const RECONNECT_MAX_MS = 30_000;

/**
 * Espera antes de reconectar, con retroceso exponencial acotado.
 *
 * Se exporta para poder probarla sin montar el hook: es la política que
 * decide cuánto insiste el HUD cuando el backend se cae.
 */
export function reconnectDelayMs(attempt: number, minMs = RECONNECT_MIN_MS, maxMs = RECONNECT_MAX_MS): number {
  const safeAttempt = Math.max(0, Math.floor(attempt));
  return Math.min(maxMs, minMs * 2 ** safeAttempt);
}

export function useHealthPolling(): () => void {
  const setHealth = useJarvisStore((state) => state.setHealth);
  const setHealthLoading = useJarvisStore((state) => state.setHealthLoading);
  const setHealthError = useJarvisStore((state) => state.setHealthError);
  const sourceRef = useRef<EventSource | null>(null);
  const timerRef = useRef<number | null>(null);
  const attemptRef = useRef(0);

  const apply = useCallback(
    (report: HealthReport) => {
      setHealth(report);
      setHealthError(null);
      setHealthLoading(false);
    },
    [setHealth, setHealthError, setHealthLoading],
  );

  const refresh = useCallback(async () => {
    // Consulta puntual bajo demanda (el botón "refrescar" del HUD): el canal
    // de streaming sigue siendo la vía normal.
    setHealthLoading(true);
    try {
      const response = await fetch(`${API_BASE}/api/health`);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      apply((await response.json()) as HealthReport);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Backend no disponible";
      setHealth(null);
      setHealthError(message);
    } finally {
      setHealthLoading(false);
    }
  }, [apply, setHealthError, setHealthLoading]);

  useEffect(() => {
    let disposed = false;

    const connect = (): void => {
      if (disposed) return;
      const source = new EventSource(`${API_BASE}/api/health/stream`);
      sourceRef.current = source;

      source.onopen = () => {
        attemptRef.current = 0;
      };
      source.onmessage = (event) => {
        try {
          apply(JSON.parse(event.data) as HealthReport);
        } catch {
          // Un evento corrupto no debe tumbar el canal: se ignora.
        }
      };
      source.onerror = () => {
        // `EventSource` reintenta solo, pero sin control del intervalo: se
        // cierra y se reconecta con espera exponencial propia.
        source.close();
        sourceRef.current = null;
        if (disposed) return;
        const wait = reconnectDelayMs(attemptRef.current);
        attemptRef.current += 1;
        timerRef.current = window.setTimeout(connect, wait);
      };
    };

    connect();
    return () => {
      disposed = true;
      if (timerRef.current !== null) window.clearTimeout(timerRef.current);
      timerRef.current = null;
      sourceRef.current?.close();
      sourceRef.current = null;
    };
  }, [apply]);

  return refresh;
}
