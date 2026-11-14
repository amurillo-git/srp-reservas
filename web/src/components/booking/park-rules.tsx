"use client";

import { useRef } from "react";

interface Norma {
  readonly icono: string;
  readonly titulo: string;
  readonly texto: string;
  /** Version corta: las normas que la tienen se muestran siempre a la vista
   * en la pantalla de revision; el texto completo va en la ventana emergente. */
  readonly resumen?: string;
}

const NORMAS: readonly Norma[] = [
  { icono: "🚫", titulo: "Alcohol y drogas", texto: "Prohibido conducir bajo sus efectos." },
  {
    icono: "🧒",
    titulo: "Edad mínima",
    texto:
      "La edad mínima para conducir es de 9 años. Los menores de edad deben estar acompañados por el adulto responsable.",
    resumen: "Edad mínima para conducir: 9 años. Los menores van acompañados por el adulto responsable.",
  },
  {
    icono: "👟",
    titulo: "Calzado",
    texto: "Es obligatorio utilizar zapatos cerrados.",
    resumen: "Zapatos cerrados obligatorios.",
  },
  { icono: "⚖️", titulo: "Peso máximo", texto: "100 kg por persona, sin excepción." },
  {
    icono: "⏰",
    titulo: "Puntualidad",
    texto:
      "Es obligatorio llegar al menos 10 minutos antes de la hora reservada. La hora de la reserva corresponde al inicio del heat, por lo que los participantes deben estar listos para ingresar a la pista a esa hora. En caso de llegar tarde, perderán su turno asignado y deberán esperar hasta que haya un nuevo espacio disponible.",
    resumen: "Llegar al menos 10 minutos antes. Quien llegue tarde pierde su turno.",
  },
  {
    icono: "📅",
    titulo: "Cambios de reserva",
    texto: "Se permiten modificaciones con un mínimo de 48 horas de anticipación, sujetas a disponibilidad.",
  },
  {
    icono: "💰",
    titulo: "Devoluciones",
    texto: "No se realizan reembolsos.",
    resumen: "No se realizan reembolsos.",
  },
  { icono: "🪖", titulo: "Casco", texto: "Su uso es obligatorio durante toda la actividad." },
  {
    icono: "📝",
    titulo: "Descargo de responsabilidad",
    texto: "Es obligatorio firmarlo antes de utilizar los karts.",
  },
  {
    icono: "🏎️",
    titulo: "Seguridad",
    texto: "Respetar las instrucciones del personal y las normas de conducción de la pista.",
  },
  {
    icono: "🤝",
    titulo: "Conducta",
    texto:
      "Mantener un comportamiento respetuoso y responsable. Se prohíben las maniobras peligrosas, los choques intencionales y cualquier conducta que ponga en riesgo a otras personas. El incumplimiento podrá ocasionar la suspensión inmediata de la actividad.",
  },
];

/** Identifica la version del texto de arriba (fecha en que quedo vigente). Se
 * guarda con cada reserva como respaldo de que normas vio y acepto el cliente:
 * CAMBIARLA cada vez que se modifique el texto de las normas. */
export const VERSION_NORMAS = "2026-11-13";

/** Normas de uso del parque, en la pantalla de revision: las mas importantes
 * siempre a la vista, el texto completo en una ventana emergente, y la casilla
 * de aceptacion que el cliente debe marcar para poder confirmar la reserva. */
export function NormasDeUso({
  aceptadas,
  onCambiarAceptadas,
  deshabilitado = false,
}: {
  aceptadas: boolean;
  onCambiarAceptadas: (aceptadas: boolean) => void;
  deshabilitado?: boolean;
}) {
  const dialogo = useRef<HTMLDialogElement>(null);
  const abrir = () => dialogo.current?.showModal();
  const cerrar = () => dialogo.current?.close();

  return (
    <div className="flex flex-col gap-3">
      <section aria-labelledby="normas-titulo" className="flex flex-col gap-3 rounded-2xl border p-4 text-sm">
        <h3 id="normas-titulo" className="font-semibold">
          🏁 Normas de uso – Sarapiquí Race Park
        </h3>
        <ul className="flex flex-col gap-2">
          {NORMAS.filter((n) => n.resumen).map((norma) => (
            <li key={norma.titulo} className="flex gap-2">
              <span aria-hidden="true">{norma.icono}</span>
              <span>{norma.resumen}</span>
            </li>
          ))}
        </ul>
        <button
          type="button"
          onClick={abrir}
          className="w-fit font-medium text-primary underline underline-offset-4"
        >
          Ver todas las normas
        </button>
      </section>

      <label htmlFor="acepta-normas" className="flex cursor-pointer items-start gap-3 text-sm font-medium">
        <input
          id="acepta-normas"
          type="checkbox"
          className="mt-0.5 size-5 shrink-0 accent-primary"
          checked={aceptadas}
          onChange={(e) => onCambiarAceptadas(e.target.checked)}
          disabled={deshabilitado}
        />
        Acepto las normas de uso del parque
      </label>

      <dialog
        ref={dialogo}
        aria-labelledby="normas-completas-titulo"
        onClick={(e) => {
          if (e.target === dialogo.current) cerrar();
        }}
        className="m-auto max-h-[85vh] w-[calc(100%-2rem)] max-w-lg flex-col overflow-hidden rounded-2xl border bg-background p-0 text-foreground shadow-xl backdrop:bg-black/50 open:flex"
      >
        <div className="flex items-center justify-between gap-3 border-b px-5 py-4">
          <h2 id="normas-completas-titulo" className="text-base font-semibold">
            🏁 Normas de uso – Sarapiquí Race Park
          </h2>
          <button type="button" onClick={cerrar} aria-label="Cerrar" className="text-muted-foreground text-xl leading-none">
            ✕
          </button>
        </div>
        <div className="flex-1 overflow-y-auto px-5 py-4 text-sm">
          <ol className="flex flex-col gap-3">
            {NORMAS.map((norma, i) => (
              <li key={norma.titulo} className="flex gap-2">
                <span className="text-muted-foreground w-5 shrink-0 text-right">{i + 1}.</span>
                <span>
                  <span aria-hidden="true">{norma.icono} </span>
                  <span className="font-semibold">{norma.titulo}:</span> {norma.texto}
                </span>
              </li>
            ))}
          </ol>
          <p className="mt-4 font-semibold">¡La diversión es mejor cuando todos corremos seguros!</p>
        </div>
        <div className="border-t px-5 py-3">
          <button
            type="button"
            onClick={cerrar}
            className="w-full rounded-2xl bg-primary px-4 py-2 text-sm font-medium text-primary-foreground"
          >
            Cerrar
          </button>
        </div>
      </dialog>
    </div>
  );
}
