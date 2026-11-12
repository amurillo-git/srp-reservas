const NORMAS: readonly { readonly icono: string; readonly titulo: string; readonly texto: string }[] = [
  { icono: "🚫", titulo: "Alcohol y drogas", texto: "Prohibido conducir bajo sus efectos." },
  { icono: "👟", titulo: "Calzado", texto: "Es obligatorio utilizar zapatos cerrados." },
  { icono: "⚖️", titulo: "Peso máximo", texto: "100 kg por persona, sin excepción." },
  {
    icono: "⏰",
    titulo: "Puntualidad",
    texto:
      "Deben estar listos para iniciar a la hora reservada, por lo que se recomienda llegar con unos minutos de anticipación.",
  },
  {
    icono: "📅",
    titulo: "Cambios de reserva",
    texto: "Se permiten modificaciones con un mínimo de 48 horas de anticipación, sujetas a disponibilidad.",
  },
  { icono: "💰", titulo: "Devoluciones", texto: "No se realizan reembolsos." },
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
export const VERSION_NORMAS = "2026-11-11";

/** Normas de uso del parque: se muestran en la pantalla de revision, antes de
 * confirmar la reserva, y el cliente debe aceptarlas para continuar. */
export function NormasDeUso() {
  return (
    <section aria-labelledby="normas-titulo" className="flex flex-col gap-3 rounded-2xl border p-4 text-sm">
      <h3 id="normas-titulo" className="font-semibold">
        🏁 Normas de uso – Sarapiquí Race Park
      </h3>
      <ol className="flex flex-col gap-2">
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
      <p className="font-semibold">¡La diversión es mejor cuando todos corremos seguros!</p>
    </section>
  );
}
