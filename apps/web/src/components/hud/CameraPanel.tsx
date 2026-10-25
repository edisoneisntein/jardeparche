import { useState } from "react";
import { analyzeImage } from "../../api/client";
import type { ClientCommand, ConnectionState } from "../../lib/events";
import { formatBytes } from "../../lib/format";
import { useJarvisStore } from "../../state/jarvisStore";
import { useCamera } from "../../hooks/useCamera";
import { CameraIcon } from "./icons";

interface CameraPanelProps {
  sessionId: string | null;
  connection: ConnectionState;
  cameraEnabled: boolean;
  sendCommand: (command: ClientCommand) => boolean;
}

export function CameraPanel({ sessionId, connection, cameraEnabled, sendCommand }: CameraPanelProps) {
  const camera = useCamera(cameraEnabled);
  const [prompt, setPrompt] = useState("");
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const completeAssistantMessage = useJarvisStore((state) => state.completeAssistantMessage);
  const addSystemMessage = useJarvisStore((state) => state.addSystemMessage);
  const recordActivity = useJarvisStore((state) => state.recordActivity);

  const analyze = async () => {
    if (!sessionId) return;
    const frame = camera.capture();
    if (!frame) {
      setStatus("No hay fotograma disponible. Activa la cámara primero.");
      return;
    }
    setBusy(true);
    setStatus(`Fotograma ${formatBytes(frame.dataUrl.length)} capturado, analizando…`);
    const sent =
      connection === "open" &&
      sendCommand({
        type: "perception.image",
        sessionId,
        dataUrl: frame.dataUrl,
        prompt: prompt.trim() || undefined,
        cameraActive: camera.active,
      });
    if (!sent) {
      try {
        const result = await analyzeImage({
          sessionId,
          dataUrl: frame.dataUrl,
          prompt: prompt.trim() || undefined,
          cameraActive: camera.active,
        });
        completeAssistantMessage(result.text);
        setStatus("Análisis completado (vía HTTP).");
      } catch (error) {
        const message = error instanceof Error ? error.message : "Análisis fallido";
        addSystemMessage(`Percepción: ${message}`);
        setStatus(message);
      }
    } else {
      setStatus("Petición enviada al backend.");
    }
    recordActivity({
      kind: "perception",
      title: "Análisis puntual solicitado",
      detail: `${frame.width}×${frame.height}`,
      tone: "info",
    });
    setBusy(false);
  };

  return (
    <section className="panel camera-panel" aria-label="Percepción visual">
      <div className="section-heading">
        <h3>PERCEPCIÓN</h3>
        {camera.active ? (
          <span className="rec-badge" role="status">
            <span className="rec-dot" aria-hidden="true" /> CÁMARA ACTIVA
          </span>
        ) : (
          <span className="idle-badge">INACTIVA</span>
        )}
      </div>

      <div className="camera-viewport">
        <video ref={camera.videoRef} muted playsInline aria-label="Vista de cámara" />
        {!camera.active ? <span className="camera-placeholder">Sin señal</span> : null}
      </div>

      {camera.error ? <p className="inline-error">{camera.error}</p> : null}

      <label className="field">
        <span>Instrucción de análisis (opcional)</span>
        <input
          type="text"
          value={prompt}
          onChange={(event) => setPrompt(event.target.value)}
          placeholder="Describe lo que ves"
        />
      </label>

      <div className="camera-actions">
        {camera.active ? (
          <button type="button" className="ghost-button" onClick={camera.stop}>
            Detener cámara
          </button>
        ) : (
          <button type="button" className="primary-button" onClick={() => void camera.start()} disabled={camera.starting || !cameraEnabled}>
            <CameraIcon /> {camera.starting ? "Iniciando…" : "Activar cámara"}
          </button>
        )}
        <button type="button" className="ghost-button" onClick={() => void analyze()} disabled={!sessionId || busy || !camera.active}>
          Analizar fotograma
        </button>
      </div>

      {!cameraEnabled ? <p className="panel-footnote">La cámara está deshabilitada en los ajustes.</p> : null}
      <p className="panel-footnote">
        Percepción puntual: se analiza una imagen por petición. No hay captura continua ni en segundo plano.
      </p>
      {status ? <p className="panel-footnote">{status}</p> : null}
    </section>
  );
}
