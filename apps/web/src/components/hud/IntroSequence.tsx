import { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import type { ConnectionState } from "../../lib/events";
import { CoreFace } from "./CoreFace";

interface IntroSequenceProps {
  reducedMotion: boolean;
  onDone: () => void;
  /** Estado real del enlace con el núcleo. */
  connection: ConnectionState;
}

const STEPS = [
  { at: 3400, label: "energizando núcleo" },
  { at: 4400, label: "calibrando sensores" },
  { at: 5300, label: "enlazando memoria" },
  { at: 6200, label: "verificando herramientas" },
  { at: 7000, label: "sistemas en línea" },
];

/**
 * Estado de cada paso según el enlace REAL. Antes todos los pasos se
 * marcaban "ok" sin comprobar nada.
 */
function stepState(label: string, connection: ConnectionState): string {
  if (label === "sistemas en línea") {
    return connection === "open" ? "ok" : "esperando";
  }
  if (label === "enlazando memoria" || label === "verificando herramientas") {
    return connection === "open" ? "ok" : "pendiente";
  }
  return "en curso";
}

/** Duración de la intro si no hay audio (modo degradado). */
const TOTAL_MS = 8200;
/** Audio de apertura. */
const INTRO_AUDIO = "/assets/jarvis/intro.mp3";

/**
 * Secuencia de arranque cinematográfica.
 *
 * Reglas que pediste:
 *
 *  · El audio **arranca desde el principio de la aplicación** y **no se corta
 *    hasta el final**: la intro dura lo que dura la pista (4:15), no 8
 *    segundos. Antes se cortaba a los 8,2 s y además el `play()` inicial lo
 *    bloqueaba el navegador (política de reproducción automática), así que
 *    la apertura sonaba a medias o no sonaba.
 *  · Para que suene de verdad hace falta un gesto del usuario: se pide con
 *    un "INICIAR" claro, y al pulsarlo el audio arranca desde el segundo 0.
 *  · **Solo se salta con el botón**, no con cualquier clic o tecla: un clic
 *    perdido ya no arruina la apertura.
 */
export function IntroSequence({ reducedMotion, onDone, connection }: IntroSequenceProps) {
  const [step, setStep] = useState(0);
  const [audioEl, setAudioEl] = useState<HTMLAudioElement | null>(null);
  const [leaving, setLeaving] = useState(false);
  const [arrancado, setArrancado] = useState(false);
  const [progreso, setProgreso] = useState(0);
  const [minutos, setMinutos] = useState("0:00");
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const doneRef = useRef(false);

  const finish = () => {
    if (doneRef.current) return;
    doneRef.current = true;
    const audio = audioRef.current;
    if (audio) {
      audio.pause();
      audio.onended = null;
    }
    setLeaving(true);
    window.setTimeout(() => onDone(), 420);
  };

  // El audio se prepara al montar, pero NO se reproduce: sin un gesto del
  // usuario el navegador lo rechaza y la apertura se quedaría muda.
  useEffect(() => {
    if (reducedMotion) {
      const timer = window.setTimeout(finish, 900);
      return () => window.clearTimeout(timer);
    }

    const audio = new Audio(INTRO_AUDIO);
    audio.preload = "auto";
    audio.volume = 0;
    audioRef.current = audio;
    setAudioEl(audio);

    const alTerminar = () => {
      // La pista llegó a su final: la intro se acaba aquí, no antes.
      finish();
    };
    audio.onended = alTerminar;
    audio.onerror = () => {
      audio.onended = null;
    };

    // La apertura se intenta sola: el usuario ya ha pulsado "entrar" en la
    // pantalla de arranque, así que el navegador tiene la activación y el
    // audio puede sonar. Si aun así lo rechaza (carga directa en la intro),
    // se muestra el botón INICIAR.
    const arranque = () => {
      audio.currentTime = 0;
      let fade = 0;
      const fadeTimer = window.setInterval(() => {
        fade += 1;
        if (audio.volume < 0.85) audio.volume = Math.min(0.85, audio.volume + 0.05);
        if (fade > 40) window.clearInterval(fadeTimer);
      }, 120);
      audio.play().then(
        () => setArrancado(true),
        () => {
          window.clearInterval(fadeTimer);
          setArrancado(false);
        },
      );
    };
    arranque();

    return () => {
      audio.pause();
      audio.onended = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reducedMotion]);

  // Un solo reloj: el log de arranque y la barra de progreso siguen la
  // posición REAL del audio (no un temporizador aparte que se desincroniza).
  useEffect(() => {
    if (reducedMotion) return;
    const inicio = Date.now();
    const intervalo = window.setInterval(() => {
      const audio = audioRef.current;
      const reproduciendose = audio !== null && !audio.paused && audio.currentTime > 0;
      const segundosAudio = audio ? audio.currentTime || 0 : 0;
      const posicion = reproduciendose ? segundosAudio : (Date.now() - inicio) / 1000;

      // Los pasos del log se marcan según el tiempo del audio.
      let nuevo = 0;
      for (let indice = 0; indice < STEPS.length; indice += 1) {
        if (posicion * 1000 >= (STEPS[indice]?.at ?? 0)) nuevo = indice;
      }
      setStep(nuevo);

      if (!reproduciendose || !audio) return;
      const duracion = audio.duration && Number.isFinite(audio.duration) ? audio.duration : 0;
      setProgreso(duracion > 0 ? Math.min(1, posicion / duracion) : 0);
      const restante = Math.max(0, duracion - posicion);
      const minutos = Math.floor(restante / 60);
      const segundos = Math.floor(restante % 60);
      setMinutos(`${minutos}:${String(segundos).padStart(2, "0")}`);
    }, 200);
    return () => window.clearInterval(intervalo);
  }, [reducedMotion]);

  const iniciar = () => {
    if (arrancado) return;
    const audio = audioRef.current;
    if (!audio) return;
    // El gesto del usuario es lo que autoriza la reproducción: desde aquí
    // suena desde el segundo 0.
    audio.currentTime = 0;
    let fade = 0;
    const fadeTimer = window.setInterval(() => {
      fade += 1;
      if (audio.volume < 0.85) audio.volume = Math.min(0.85, audio.volume + 0.05);
      if (fade > 40) window.clearInterval(fadeTimer);
    }, 120);
    audio.play().then(
      () => setArrancado(true),
      () => {
        window.clearInterval(fadeTimer);
        // Si el navegador lo rechaza, la intro sigue en modo silencioso.
        window.setTimeout(finish, TOTAL_MS);
      },
    );
  };

  return (
    <AnimatePresence>
      {!leaving ? (
        <motion.div
          className="intro-screen"
          initial={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.4 }}
          role="presentation"
        >
          <div className="intro-vignette" />

          {/* El núcleo: solo la imagen del HUD de Iron Man (jarvis.jpeg),
              grande, iluminada y girando en 3D como un holograma. */}
          <div className="intro-core-wrap intro-core-wide" aria-hidden="true">
            <CoreFace audio={audioEl} src="/assets/jarvis/hero-ironman-hud.jpg" animated={!reducedMotion} />
          </div>

          {!reducedMotion ? (
            <>
              <motion.div
                className="intro-ring"
                initial={{ scale: 0.4, opacity: 0 }}
                animate={{ scale: [0.4, 2.4], opacity: [0, 0.7, 0] }}
                transition={{ duration: 3.4, delay: 1.4, ease: "easeOut" }}
              />
              <motion.div
                className="intro-ring intro-ring-delayed"
                initial={{ scale: 0.4, opacity: 0 }}
                animate={{ scale: [0.4, 2.1], opacity: [0, 0.55, 0] }}
                transition={{ duration: 3, delay: 2.4, ease: "easeOut" }}
              />
            </>
          ) : null}

          <motion.div
            className="intro-title"
            initial={{ opacity: 0, letterSpacing: "0.6em" }}
            animate={{ opacity: 1, letterSpacing: "0.24em" }}
            transition={{ duration: reducedMotion ? 0.4 : 1.6, delay: reducedMotion ? 0 : 0.5 }}
          >
            J.A.R.V.I.S.
          </motion.div>

          <motion.div
            className="intro-subtitle"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ duration: 0.8, delay: reducedMotion ? 0.2 : 1.4 }}
          >
            Just A Rather Very Intelligent System
          </motion.div>

          <div className="intro-log" aria-hidden="true">
            {STEPS.slice(0, step + 1).map((entry) => (
              <motion.div
                key={entry.label}
                className="intro-log-line"
                initial={{ opacity: 0, x: -8 }}
                animate={{ opacity: 1, x: 0 }}
                transition={{ duration: 0.3 }}
              >
                <span className="intro-log-tick">›</span>
                {entry.label}
                <span className="intro-log-ok" data-state={stepState(entry.label, connection)}>
                  {stepState(entry.label, connection)}
                </span>
              </motion.div>
            ))}
          </div>

          <div className="intro-progress">
            <motion.div
              className="intro-progress-fill"
              initial={{ scaleX: 0 }}
              animate={{ scaleX: arrancado ? Math.max(0.02, progreso) : 0.15 + step * 0.21 }}
              transition={{ duration: 0.4, ease: "easeOut" }}
            />
          </div>

          {arrancado ? (
            <div className="intro-remaining">queda {minutos} de la apertura</div>
          ) : (
            <button type="button" className="intro-start" onClick={iniciar} autoFocus>
              <span className="intro-start-label">INICIAR</span>
              <span className="intro-start-hint">la apertura se reproduce entera</span>
            </button>
          )}

          <button type="button" className="intro-skip" onClick={finish}>
            saltar
          </button>
        </motion.div>
      ) : null}
    </AnimatePresence>
  );
}
