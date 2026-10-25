import { useEffect, useState } from "react";
import type { JarvisSettings } from "../../state/settings";
import { isSpeechSynthesisAvailable, listVoices } from "../../lib/tts";
import { getUsers } from "../../api/client";
import { CloseIcon } from "./icons";

interface SettingsPanelProps {
  settings: JarvisSettings;
  onChange: (patch: Partial<JarvisSettings>) => void;
  onClose: () => void;
}

export function SettingsPanel({ settings, onChange, onClose }: SettingsPanelProps) {
  const [voices, setVoices] = useState<SpeechSynthesisVoice[]>(() => listVoices());
  // Usuarios que el servidor autoriza de verdad: escribir un identificador
  // libre acababa en un 403 sin explicación.
  const [users, setUsers] = useState<string[]>([]);

  useEffect(() => {
    if (!isSpeechSynthesisAvailable()) return;
    const update = () => setVoices(listVoices());
    update();
    window.speechSynthesis.addEventListener("voiceschanged", update);
    return () => window.speechSynthesis.removeEventListener("voiceschanged", update);
  }, []);

  useEffect(() => {
    let alive = true;
    void getUsers()
      .then((response) => {
        if (alive) setUsers(response.users);
      })
      .catch(() => {
        if (alive) setUsers([]);
      });
    return () => {
      alive = false;
    };
  }, []);

  return (
    <aside className="settings-panel" role="dialog" aria-label="Ajustes" aria-modal="false">
      <header className="section-heading">
        <h3>AJUSTES</h3>
        <button type="button" className="icon-button" onClick={onClose} aria-label="Cerrar ajustes">
          <CloseIcon />
        </button>
      </header>

      <label className="field">
        <span>Usuario</span>
        <select value={settings.userId} onChange={(event) => onChange({ userId: event.target.value })}>
          {(users.length > 0 ? users : [settings.userId]).map((user) => (
            <option key={user} value={user}>
              {user}
            </option>
          ))}
        </select>
        <small>
          Usuarios autorizados por el servidor (JARVIS_USERS). Determina el aislamiento de memoria. Cambiarlo
          recarga la sesión.
        </small>
      </label>

      <label className="field">
        <span>Idioma de voz</span>
        <input
          type="text"
          value={settings.language}
          onChange={(event) => onChange({ language: event.target.value })}
          placeholder="es-ES"
        />
      </label>

      <label className="field">
        <span>Origen de la transcripción</span>
        <select
          value={settings.voiceAsrMode}
          onChange={(event) => onChange({ voiceAsrMode: event.target.value as "browser" | "server" })}
        >
          <option value="browser">Navegador (Web Speech API)</option>
          <option value="server">Servidor (ASR de NVIDIA)</option>
        </select>
        <small>
          Con «Servidor», el navegador solo captura el audio y el servidor lo transcribe y decide el fin de la
          intervención. Si el modelo de ASR no está disponible, cae al navegador.
        </small>
      </label>

      <label className="field">
        <span>Palabra de activación</span>
        <input
          type="text"
          value={settings.wakeWord}
          onChange={(event) => onChange({ wakeWord: event.target.value })}
          placeholder="jarvis"
        />
        <small>
          Si la dices, se quita del comando. Deja el campo vacío para no usar palabra de activación.
        </small>
      </label>

      <label className="field field-check">
        <input
          type="checkbox"
          checked={settings.requireWakeWord}
          onChange={(event) => onChange({ requireWakeWord: event.target.checked })}
        />
        <span>Exigir la palabra de activación</span>
        <small>
          Activado, el micrófono solo envía la orden si ha detectado «{settings.wakeWord || "la palabra de activación"}».
          Desactivado (por defecto), cualquier frase es una orden.
        </small>
      </label>

      <label className="field">
        <span>Voz de síntesis</span>
        <select
          value={settings.voiceURI}
          onChange={(event) => onChange({ voiceURI: event.target.value })}
          disabled={!isSpeechSynthesisAvailable()}
        >
          <option value="">Predeterminada del sistema</option>
          {voices.map((voice) => (
            <option key={voice.voiceURI} value={voice.voiceURI}>
              {voice.name} ({voice.lang})
            </option>
          ))}
        </select>
        {!isSpeechSynthesisAvailable() ? <small>Este navegador no expone síntesis de voz.</small> : null}
      </label>

      <div className="toggle-group">
        <label className="toggle">
          <input
            type="checkbox"
            checked={settings.ttsEnabled}
            onChange={(event) => onChange({ ttsEnabled: event.target.checked })}
          />
          <span>Respuestas habladas</span>
        </label>
        <label className="toggle">
          <input
            type="checkbox"
            checked={settings.uiSounds}
            onChange={(event) => onChange({ uiSounds: event.target.checked })}
          />
          <span>Pitidos de interfaz</span>
        </label>
        <label className="toggle">
          <input
            type="checkbox"
            checked={settings.reducedMotion}
            onChange={(event) => onChange({ reducedMotion: event.target.checked })}
          />
          <span>Movimiento reducido</span>
        </label>
        <label className="toggle">
          <input
            type="checkbox"
            checked={settings.cameraEnabled}
            onChange={(event) => onChange({ cameraEnabled: event.target.checked })}
          />
          <span>Permitir cámara (siempre explícita)</span>
        </label>
      </div>

      <p className="panel-footnote">
        Las claves de NVIDIA viven solo en el backend. Este cliente nunca recibe ni almacena secretos.
      </p>
    </aside>
  );
}
