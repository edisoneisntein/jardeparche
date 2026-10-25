import { useEffect, useRef } from "react";

/**
 * El rostro del núcleo: una cara holográfica que respira, se descompone en
 * partículas, vuelve a formarse y **gira la cabeza** como quien mira alrededor.
 *
 * Cómo funciona:
 *
 *  1. La imagen del rostro se dibuja en un lienzo fuera de pantalla a tamaño
 *     reducido y se leen sus píxeles: los que brillan son la cara. De cada uno
 *     se toma un punto de anclaje.
 *  2. Cada partícula vive en su punto de anclaje con un muelle; por encima
 *     actúan la deriva y un impulso proporcional al volumen del audio.
 *  3. El volumen (RMS del `AnalyserNode`) mueve el brillo de la cara, el
 *     tamaño de las partículas y su deriva: cuando JARVIS habla, la cara late.
 *  4. La cabeza gira: una animación de reposo (mira abajo, a un lado, al otro)
 *     más el seguimiento del ratón, componiendo dos rotaciones 3D.
 */

interface CoreFaceProps {
  /** Elemento de audio de la apertura (para analizar su volumen). */
  audio: HTMLAudioElement | null;
  /** Imagen del rostro. */
  src: string;
  /** Activa las animaciones (respeta "reducir movimiento"). */
  animated: boolean;
}

interface Particle {
  /** Punto de anclaje (donde está la cara), en píxeles del lienzo. */
  homeX: number;
  homeY: number;
  x: number;
  y: number;
  vx: number;
  vy: number;
  /** Fase para que cada partícula se mueva a su ritmo. */
  phase: number;
  size: number;
}

const SAMPLE_WIDTH = 150;
const MAX_PARTICLES = 1200;

export function CoreFace({ audio, src, animated }: CoreFaceProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const imagenRef = useRef<HTMLImageElement | null>(null);
  const particulasRef = useRef<Particle[]>([]);
  const listoRef = useRef(false);
  const raizRef = useRef<HTMLDivElement | null>(null);

  // ── Seguimiento del ratón: la cabeza mira hacia donde está el puntero ──
  useEffect(() => {
    if (!animated) return;
    const raiz = raizRef.current;
    if (!raiz) return;
    let objetivoY = 0;
    let objetivoX = 0;
    let actualY = 0;
    let actualX = 0;

    const alMover = (evento: MouseEvent) => {
      const centroX = window.innerWidth / 2;
      const centroY = window.innerHeight / 2;
      objetivoY = ((evento.clientX - centroX) / centroX) * 13; // ±13°
      objetivoX = ((evento.clientY - centroY) / centroY) * -8; // ±8°
    };
    const alSalir = () => {
      objetivoY = 0;
      objetivoX = 0;
    };
    const bucle = () => {
      actualY += (objetivoY - actualY) * 0.05;
      actualX += (objetivoX - actualX) * 0.05;
      raiz.style.setProperty("--turn-y", `${actualY.toFixed(2)}deg`);
      raiz.style.setProperty("--turn-x", `${actualX.toFixed(2)}deg`);
      requestAnimationFrame(bucle);
    };
    window.addEventListener("mousemove", alMover);
    window.addEventListener("mouseleave", alSalir);
    const animacion = requestAnimationFrame(bucle);
    return () => {
      window.removeEventListener("mousemove", alMover);
      window.removeEventListener("mouseleave", alSalir);
      cancelAnimationFrame(animacion);
    };
  }, [animated]);

  useEffect(() => {
    if (!animated) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    let animacion = 0;
    let nivel = 0; // volumen suavizado 0..1
    let analyser: AnalyserNode | null = null;
    let datos: Uint8Array<ArrayBuffer> | null = null;
    let contexto: AudioContext | null = null;

    // ── 1. Analizador de audio (si el navegador lo permite) ─────────────
    //
    // Se usa `captureStream()` y NO `createMediaElementSource()`: conectar
    // el elemento al grafo de Web Audio lo haría sonar a través del contexto,
    // y si el contexto está suspendido (sin gesto de usuario) el sonido
    // desaparecería. Con `captureStream` solo se ESCUCHA el audio: la
    // reproducción sigue por su cuenta y no se puede romper.
    const conectarAnalizador = () => {
      if (!audio) return;
      try {
        const capturable = audio as HTMLAudioElement & { captureStream?: () => MediaStream };
        const flujo = typeof capturable.captureStream === "function" ? capturable.captureStream() : null;
        if (!flujo) return;
        contexto = new (window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext)();
        const fuente = contexto.createMediaStreamSource(flujo);
        analyser = contexto.createAnalyser();
        analyser.fftSize = 512;
        datos = new Uint8Array(analyser.fftSize);
        fuente.connect(analyser); // sin destino: es una escucha pasiva
        void contexto.resume();
      } catch {
        analyser = null;
      }
    };

    const leerNivel = (): number => {
      if (!analyser || !datos) return 0;
      analyser.getByteTimeDomainData(datos);
      let suma = 0;
      for (let indice = 0; indice < datos.length; indice += 1) {
        const valor = (datos[indice] ?? 128) - 128;
        suma += valor * valor;
      }
      const rms = Math.sqrt(suma / datos.length) / 128;
      return Math.min(1, rms * 3.2);
    };

    // ── 2. Partículas a partir de los píxeles brillantes de la cara ─────
    const prepararParticulas = () => {
      const imagen = imagenRef.current;
      if (!imagen || !imagen.complete || imagen.naturalWidth === 0) return;
      const proporcion = imagen.naturalHeight / imagen.naturalWidth;
      const alto = Math.max(1, Math.round(SAMPLE_WIDTH * proporcion));
      const fuera = document.createElement("canvas");
      fuera.width = SAMPLE_WIDTH;
      fuera.height = alto;
      const ctxFuera = fuera.getContext("2d", { willReadFrequently: true });
      if (!ctxFuera) return;
      ctxFuera.drawImage(imagen, 0, 0, SAMPLE_WIDTH, alto);
      const pixeles = ctxFuera.getImageData(0, 0, SAMPLE_WIDTH, alto).data;

      const candidatas: Array<{ x: number; y: number; brillo: number }> = [];
      for (let y = 0; y < alto; y += 1) {
        for (let x = 0; x < SAMPLE_WIDTH; x += 1) {
          const indice = (y * SAMPLE_WIDTH + x) * 4;
          const rojo = pixeles[indice] ?? 0;
          const verde = pixeles[indice + 1] ?? 0;
          const azul = pixeles[indice + 2] ?? 0;
          const brillo = (rojo + verde + azul) / 3;
          if (brillo > 34) candidatas.push({ x, y, brillo });
        }
      }
      if (candidatas.length === 0) return;

      const ancho = canvas.clientWidth || SAMPLE_WIDTH;
      const escalaX = ancho / SAMPLE_WIDTH;
      const escalaY = (canvas.clientHeight || alto) / alto;
      const particulas: Particle[] = [];
      for (const punto of candidatas) {
        if (particulas.length >= MAX_PARTICLES) break;
        const homeX = punto.x * escalaX;
        const homeY = punto.y * escalaY;
        particulas.push({
          homeX,
          homeY,
          x: homeX,
          y: homeY,
          vx: 0,
          vy: 0,
          phase: Math.random() * Math.PI * 2,
          size: 0.6 + (punto.brillo / 255) * 1.5,
        });
      }
      particulasRef.current = particulas;
      listoRef.current = particulas.length > 0;
    };

    // ── 3. Bucle de animación ───────────────────────────────────────────
    const dibujar = () => {
      animacion = requestAnimationFrame(dibujar);
      const objetivo = leerNivel();
      nivel += (objetivo - nivel) * 0.12; // suavizado: sin tirones
      const particulas = particulasRef.current;
      const ancho = canvas.clientWidth;
      const alto = canvas.clientHeight;
      if (canvas.width !== ancho || canvas.height !== alto) {
        canvas.width = ancho;
        canvas.height = alto;
      }
      ctx.clearRect(0, 0, ancho, alto);
      if (!listoRef.current || particulas.length === 0) return;

      const tiempo = animacion / 1000;
      for (const particula of particulas) {
        // Muelle hacia el ancla: la forma de la cara siempre se recompone.
        const fuerza = 0.055 + nivel * 0.03;
        particula.vx += (particula.homeX - particula.x) * fuerza;
        particula.vy += (particula.homeY - particula.y) * fuerza;
        // Deriva y empuje del audio.
        const deriva = 0.25 + nivel * 5.5;
        particula.vx += Math.sin(tiempo * 0.7 + particula.phase) * deriva * 0.02;
        particula.vy += Math.cos(tiempo * 0.55 + particula.phase * 1.3) * deriva * 0.02;
        particula.vx *= 0.9;
        particula.vy *= 0.9;
        particula.x += particula.vx;
        particula.y += particula.vy;
        const brillo = 0.45 + nivel * 0.55;
        ctx.fillStyle = `rgba(120, 226, 255, ${brillo})`;
        ctx.beginPath();
        ctx.arc(particula.x, particula.y, particula.size * (0.75 + nivel * 0.5), 0, Math.PI * 2);
        ctx.fill();
      }
    };

    const imagen = new Image();
    imagen.src = src;
    imagen.crossOrigin = "anonymous";
    imagen.onload = () => {
      imagenRef.current = imagen;
      prepararParticulas();
    };
    imagenRef.current = imagen;

    conectarAnalizador();
    animacion = requestAnimationFrame(dibujar);

    const alRedimensionar = () => {
      if (listoRef.current) prepararParticulas();
    };
    window.addEventListener("resize", alRedimensionar);

    return () => {
      cancelAnimationFrame(animacion);
      window.removeEventListener("resize", alRedimensionar);
      if (contexto) void contexto.close().catch(() => undefined);
    };
  }, [audio, animated, src]);

  return (
    <div className="core-face" ref={raizRef} aria-hidden="true">
      <div className="core-face-turn">
        <div className="core-face-idle">
          <img className="core-face-img" src={src} alt="" />
          <canvas ref={canvasRef} className="core-face-particles" />
          <div className="core-face-scan" />
          <div className="core-face-flare" />
        </div>
      </div>
    </div>
  );
}
