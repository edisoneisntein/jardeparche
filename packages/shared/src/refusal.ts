/**
 * Detección de negativas del modelo.
 *
 * Una negativa («no puedo buscar eso», «las herramientas no están
 * habilitadas») es un FALLO del turno, no una respuesta: no debe llegar al
 * usuario, no debe guardarse en la caché semántica y no debe volver a
 * servirse como si fuera una respuesta válida.
 *
 * Vive en el paquete compartido porque dos capas lo necesitan:
 *  · el runtime, para reintentar con el catálogo completo;
 *  · la memoria, para no servir desde caché una negativa ya grabada.
 */

/**
 * Patrones que delatan una negativa o una excusa del modelo.
 *
 * Se han ido añadiendo con la redacción REAL que produce el modelo en
 * producción: cada patrón nuevo viene de un caso observado, no de una
 * teoría.
 */
export const REFUSAL_PATTERNS: readonly RegExp[] = [
  /no (tengo|dispongo|cuento) (de |del )?(acceso|permiso|forma|manera|modo|capacidad)/i,
  // Redacción real observada: «no dispongo de una herramienta que me permita…».
  /no (tengo|dispongo|cuento|hay|existe) (de |del )?(ninguna |ningun[ao] |una |la |el )?herramienta(s)?\b/i,
  /no (hay|existe) (ninguna |ningun[ao] |una |la |el )?herramienta(s)?\b/i,
  /(necesito|necesitar[ií]a|requiero) (consultar|verificar|comprobar|buscar|acceder|usar|utilizar|consulta|una herramienta)/i,
  /no (puedo|he podido) (consultar|verificar|buscar|acceder|calcular|obtener|decirte|darte|responder( a)? eso)/i,
  /sin (herramientas|acceso a|permiso para)/i,
  // Redacción real observada (2026-10-20): «no tengo disponible la herramienta
  // `web_search`». Los patrones anteriores exigían «no tengo + de/la +
  // herramienta» y se les escapaba el «disponible» intercalado.
  /no (tengo|hay|está|esta) (disponible|habilitada|habilitado|activada|activado)/i,
  // «No puedo activar `web_search`»: redacción real observada (2026-10-23).
  // El verbo «activar» con el nombre de la tool es una negativa disfrazada
  // de diagnóstico: el catálogo sí tenía la herramienta.
  /no (puedo|puedo activar|puedo habilitar|he podido|me deja|me dejan|no me dejan) (activar|habilitar|usar|invocar|llamar)/i,
  /no se me permite (activar|habilitar|usar|invocar|llamar)/i,
  // «en esta sesión no están habilitadas»: el plural escapaba al patrón
  // singular anterior («no está habilitada»).
  /no (est[aá]n|son) (disponibles|habilitadas|habilitados|activadas|activados|concedidas|otorgadas)/i,
  /las herramientas (solo|s[oó]lo) .*?(concedid|otorgad|habilitad|activad)/i,
  // «no están habilitadas» sin «no» delante: el modelo afirma el estado del
  // catálogo en vez de usarlo.
  /(herramientas?|tools?) .*?(no (est[aá]n|son) (habilitad|activad|disponib|concedid|otorgad)|sin (habilitar|activar))/i,
  // «Solo puedo usar las herramientas que el sistema me ha otorgado»: el
  // modelo enumera el catálogo recibido, señal de que faltan las de web.
  /(solo|s[oó]lo|únicamente|unicamente) (puedo usar|puedo usar solo|se me permite usar|me deja usar) (las |los )?herramientas? que/i,
];

/**
 * Prefijos con los que arranca una negativa del modelo.
 *
 * Se usan para decidir si un fragmento INCOMPLETO ya es una excusa: si el
 * texto empieza por "No…", todavía no se puede soltar a la voz porque la
 * frase completa podría ser una renuncia.
 */
export const REFUSAL_STEM_PATTERNS: readonly RegExp[] = [
  /^\s*no\b/i,
  /^\s*lo\s+siento\b/i,
  /^\s*disculpa\b/i,
  /^\s*lamentablemente\b/i,
  /^\s*por\s+desgracia\b/i,
  /^\s*por\s+desafortunadamente\b/i,
  /^\s*no\s+puedo\b/i,
];

/**
 * ¿El texto parece una negativa del modelo?
 *
 * Args:
 *   text: Texto acumulado del turno.
 *
 * Returns:
 *   `true` si el texto delata que el modelo se está rindiendo.
 */
export function looksLikeRefusal(text: string): boolean {
  return REFUSAL_PATTERNS.some((pattern) => pattern.test(text));
}

/**
 * ¿El inicio del texto puede ser el comienzo de una negativa?
 *
 * Permite decidir con texto incompleto: si el fragmento empieza por "No…",
 * todavía no se suelta a la voz porque la frase completa podría ser una
 * renuncia que el runtime debe retener.
 */
export function looksLikeRefusalStem(text: string): boolean {
  return REFUSAL_STEM_PATTERNS.some((pattern) => pattern.test(text));
}
