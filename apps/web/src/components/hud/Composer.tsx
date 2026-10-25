import { useState, type FormEvent, type KeyboardEvent } from "react";
import type { ConnectionState } from "../../lib/events";
import type { DictationController } from "../../hooks/useDictation";
import { MicIcon, MicOffIcon, SendIcon, SpeakerIcon, SpeakerOffIcon, StopIcon } from "./icons";

interface ComposerProps {
  connection: ConnectionState;
  agentBusy: boolean;
  dictation: DictationController;
  ttsEnabled: boolean;
  onToggleTts: () => void;
  onSend: (text: string) => void;
  onStop: () => void;
}

export function Composer({ connection, agentBusy, dictation, ttsEnabled, onToggleTts, onSend, onStop }: ComposerProps) {
  const [text, setText] = useState("");
  const [micNotice, setMicNotice] = useState<string | null>(null);
  const disabled = connection !== "open";

  const micDenied = dictation.micPermission === "denied";
  const micUnavailable = dictation.micPermission === "unavailable";
  const micBlocked = !dictation.supported || micUnavailable;
  const insecureOrigin = dictation.gate.state === "insecure-origin";
  const micStatus = insecureOrigin
    ? "Origen no seguro: el navegador bloquea el micrófono"
    : !dictation.supported
      ? "Voz no disponible en este navegador"
      : micUnavailable
        ? "Sin dispositivo de audio"
        : micDenied
          ? "Micrófono bloqueado"
          : dictation.listening
            ? "Escuchando…"
            : "Activar comando por voz";
  const micLabel = insecureOrigin
    ? `Origen no seguro (${dictation.gate.reason})`
    : dictation.listening
      ? "Detener micrófono y comando por voz"
      : micDenied
        ? "Micrófono bloqueado: abre los ajustes del sitio para permitir el acceso"
        : micUnavailable
          ? "Dispositivo de audio no detectado"
          : !dictation.supported
            ? "Voz no disponible en este navegador"
            : "Activar comando por voz";

  const handleMicClick = () => {
    if (micDenied && !insecureOrigin) {
      setMicNotice("Micrófono bloqueado por el navegador; habilítalo en los ajustes del sitio");
      return;
    }
    setMicNotice(null);
    dictation.toggle();
  };

  const submit = (event?: FormEvent) => {
    event?.preventDefault();
    const value = text.trim();
    if (!value || disabled) return;
    onSend(value);
    setText("");
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      submit();
    }
  };

  return (
    <form className="composer" onSubmit={submit} aria-label="Entrada de mensajes">
      <span className="hud-corner hud-corner-tl" aria-hidden="true" />
      <span className="hud-corner hud-corner-tr" aria-hidden="true" />
      <span className="hud-corner hud-corner-bl" aria-hidden="true" />
      <span className="hud-corner hud-corner-br" aria-hidden="true" />

      <div
        className="voice-indicator"
        data-listening={dictation.listening ? "true" : "false"}
        data-permission={dictation.micPermission}
      >
        <div className="mic-meter" aria-hidden="true">
          <span style={{ transform: `scaleX(${Math.max(0.04, dictation.micLevel)})` }} />
        </div>
        <span className="voice-state">{micStatus}</span>
        {dictation.listening && dictation.wakeWord ? (
          <span className="voice-state">di «{dictation.wakeWord}» para enviar</span>
        ) : null}
        {dictation.interim ? (
          <span className="voice-interim" role="status">
            {dictation.interim}
          </span>
        ) : null}
        {(micNotice ?? dictation.error) ? (
          <span className="voice-error" role="status">
            {micNotice ?? dictation.error}
          </span>
        ) : null}
      </div>

      <textarea
        value={text}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={onKeyDown}
        placeholder={disabled ? "Conectando con el backend…" : "Escribe una orden. Enter envía, Shift+Enter salta línea."}
        rows={2}
        disabled={disabled}
        aria-label="Mensaje para JARVIS"
      />

      <div className="composer-actions">
        <button
          type="button"
          className={`icon-button mic-button${dictation.listening ? " active" : ""}`}
          onClick={handleMicClick}
          aria-pressed={dictation.listening}
          aria-label={micLabel}
          title={micLabel}
          disabled={micBlocked}
          style={
            dictation.listening ? { animation: "bracket-pulse 1.8s ease-in-out infinite" } : undefined
          }
        >
          {micDenied || micUnavailable || !dictation.supported ? <MicOffIcon /> : <MicIcon />}
        </button>

        <button
          type="button"
          className="icon-button"
          onClick={onToggleTts}
          aria-pressed={ttsEnabled}
          aria-label={ttsEnabled ? "Silenciar respuestas habladas" : "Activar respuestas habladas"}
        >
          {ttsEnabled ? <SpeakerIcon /> : <SpeakerOffIcon />}
        </button>

        <button
          type="button"
          className="ghost-button stop-button"
          onClick={onStop}
          disabled={!agentBusy}
          aria-label="Detener la tarea en curso"
        >
          <StopIcon /> Detener
        </button>

        <button type="submit" className="primary-button send-button" disabled={disabled || text.trim().length === 0}>
          <SendIcon /> Enviar
        </button>
      </div>
    </form>
  );
}
