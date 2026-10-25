import type { ReactNode } from "react";

/**
 * Render mínimo de markdown para el panel de comunicaciones.
 *
 * El HUD muestra datos técnicos: si se deja el markdown crudo ("**negrita**",
 * "### Título", "1. Punto") se ve sucio y, además, el TTS lee los asteriscos.
 * Aquí se convierte a los pocos elementos que el panel usa: negrita, títulos,
 * listas y código en línea.
 */
export function Markdown({ text }: { text: string }): ReactNode {
  const lineas = text.split("\n");
  const bloques: ReactNode[] = [];

  let lista: string[] = [];
  const cerrarLista = (clave: number) => {
    if (lista.length === 0) return;
    bloques.push(
      <ul className="md-list" key={`ul-${clave}`}>
        {lista.map((item, indice) => (
          <li key={indice}>{enLinea(item)}</li>
        ))}
      </ul>,
    );
    lista = [];
  };

  lineas.forEach((linea, indice) => {
    const limpia = linea.trim();
    const vineta = /^[-*•]\s+(.*)$/.exec(limpia);
    const numero = /^(\d+)[.)]\s+(.*)$/.exec(limpia);
    if (vineta) {
      lista.push(vineta[1] ?? "");
      return;
    }
    if (numero) {
      lista.push(`${numero[1]}. ${numero[2] ?? ""}`);
      return;
    }
    cerrarLista(indice);
    if (!limpia) {
      bloques.push(<div className="md-gap" key={`gap-${indice}`} />);
      return;
    }
    const titulo = /^(#{1,4})\s+(.*)$/.exec(limpia);
    if (titulo) {
      const nivel = (titulo[1] ?? "#").length;
      bloques.push(
        <p className="md-title" data-level={nivel} key={`h-${indice}`}>
          {enLinea(titulo[2] ?? "")}
        </p>,
      );
      return;
    }
    bloques.push(
      <p className="md-p" key={`p-${indice}`}>
        {enLinea(linea)}
      </p>,
    );
  });
  cerrarLista(lineas.length);

  return <>{bloques}</>;
}

/** Convierte **negrita**, *cursiva* y `código` de una línea. */
function enLinea(texto: string): ReactNode {
  const partes = texto.split(/(\*\*[^*]+\*\*|\*[^*\n]+\*|`[^`]+`)/g);
  return partes.map((parte, indice) => {
    if (parte.startsWith("**") && parte.endsWith("**")) {
      return <strong key={indice}>{parte.slice(2, -2)}</strong>;
    }
    if (parte.startsWith("`") && parte.endsWith("`")) {
      return (
        <code className="md-code" key={indice}>
          {parte.slice(1, -1)}
        </code>
      );
    }
    if (parte.startsWith("*") && parte.endsWith("*") && parte.length > 2) {
      return <em key={indice}>{parte.slice(1, -1)}</em>;
    }
    return <span key={indice}>{parte}</span>;
  });
}
