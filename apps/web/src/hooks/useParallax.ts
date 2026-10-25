import { useEffect, useRef } from "react";

/**
 * Parallax holográfico y ondas expansivas.
 *
 * · **Parallax**: el puntero mueve las capas del fondo a velocidades
 *   distintas (el héroe apenas, los paneles más), como una proyección
 *   holográfica flotando en el espacio.
 * · **Onda expansiva**: cada interacción con el HUD lanza un destello cian
 *   que se abre desde el punto pulsado y viaja hacia el núcleo.
 */
export function useParallax(enabled: boolean): void {
  const rafRef = useRef(0);

  useEffect(() => {
    if (!enabled) return;
    const raiz = document.documentElement;
    let objetivoX = 0;
    let objetivoY = 0;
    let actualX = 0;
    let actualY = 0;

    const alMover = (evento: PointerEvent) => {
      objetivoX = (evento.clientX / window.innerWidth - 0.5) * 2; // -1..1
      objetivoY = (evento.clientY / window.innerHeight - 0.5) * 2;
    };
    const alSalir = () => {
      objetivoX = 0;
      objetivoY = 0;
    };
    const bucle = () => {
      actualX += (objetivoX - actualX) * 0.06;
      actualY += (objetivoY - actualY) * 0.06;
      raiz.style.setProperty("--px", actualX.toFixed(4));
      raiz.style.setProperty("--py", actualY.toFixed(4));
      rafRef.current = requestAnimationFrame(bucle);
    };
    window.addEventListener("pointermove", alMover);
    window.addEventListener("pointerleave", alSalir);
    rafRef.current = requestAnimationFrame(bucle);

    // Onda expansiva en cada pulsación del HUD.
    const alPulsar = (evento: PointerEvent) => {
      const objetivo = evento.target as HTMLElement | null;
      if (!objetivo) return;
      if (objetivo.closest(".intro-screen")) return; // la apertura va a su ritmo
      const contenedor = document.querySelector(".hud-shockwaves");
      if (!contenedor) return;
      const onda = document.createElement("span");
      onda.className = "hud-shockwave";
      onda.style.left = `${evento.clientX}px`;
      onda.style.top = `${evento.clientY}px`;
      // La onda no sale parada: viaja hacia el núcleo (el centro de la
      // pantalla) mientras se expande, como la descarga de energía del reactor.
      const centroX = window.innerWidth / 2;
      const centroY = window.innerHeight / 2;
      onda.style.setProperty("--dx", `${centroX - evento.clientX}px`);
      onda.style.setProperty("--dy", `${centroY - evento.clientY}px`);
      contenedor.appendChild(onda);
      onda.addEventListener("animationend", () => onda.remove());
    };
    window.addEventListener("pointerdown", alPulsar);

    return () => {
      window.removeEventListener("pointermove", alMover);
      window.removeEventListener("pointerleave", alSalir);
      window.removeEventListener("pointerdown", alPulsar);
      cancelAnimationFrame(rafRef.current);
    };
  }, [enabled]);
}
