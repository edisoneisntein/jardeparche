import { useEffect, useRef, useState } from "react";

/**
 * Máquina de escribir.
 *
 * El texto que llega por streaming se revela carácter a carácter (como los
 * datos técnicos del HUD de la película). Cuando el mensaje ya está completo
 * (o el usuario tiene "reducir movimiento"), se muestra entero.
 */
export function useTypewriter(text: string, activo: boolean, velocidad = 58): string {
  const [visibles, setVisibles] = useState(text);
  const pendientesRef = useRef<string[]>([]);
  const indiceRef = useRef(0);

  useEffect(() => {
    if (!activo) {
      setVisibles(text);
      indiceRef.current = text.length;
      pendientesRef.current = [];
      return;
    }
    // Si el texto cambia (sigue llegando), se encola lo que falta.
    if (text.length < indiceRef.current) {
      indiceRef.current = 0;
      setVisibles("");
    }
    const cola = text.slice(indiceRef.current);
    if (cola.length === 0) return;
    pendientesRef.current = cola.split("");
    indiceRef.current = text.length;

    const intervalo = window.setInterval(() => {
      const cola = pendientesRef.current;
      if (cola.length === 0) {
        window.clearInterval(intervalo);
        return;
      }
      // Carácter a carácter (conGroups of 1-2 para no saturar el hilo).
      const trozo = cola.splice(0, velocidad > 50 ? 2 : 1).join("");
      setVisibles((actual) => actual + trozo);
    }, Math.max(16, 1000 / velocidad));
    return () => window.clearInterval(intervalo);
  }, [text, activo, velocidad]);

  return visibles;
}
