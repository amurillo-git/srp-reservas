export function formatoMoneda(monto: number, moneda: string): string {
  return new Intl.NumberFormat("es-CR", { style: "currency", currency: moneda, maximumFractionDigits: 0 }).format(
    monto,
  );
}

/** "YYYY-MM-DD" -> "Domingo, 13 de septiembre de 2026" (solo la primera letra en mayúscula). */
export function formatoFechaLarga(fechaISO: string): string {
  const fecha = new Date(`${fechaISO}T00:00:00.000Z`);
  const texto = new Intl.DateTimeFormat("es-CR", { dateStyle: "full", timeZone: "UTC" }).format(fecha);
  return texto.charAt(0).toUpperCase() + texto.slice(1);
}

/** Fecha de una instante en la hora local del navegador (no UTC), formato "YYYY-MM-DD". */
function fechaLocalISO(fecha: Date): string {
  const anio = fecha.getFullYear();
  const mes = String(fecha.getMonth() + 1).padStart(2, "0");
  const dia = String(fecha.getDate()).padStart(2, "0");
  return `${anio}-${mes}-${dia}`;
}

/** Fecha de hoy en la hora local del navegador (no UTC), formato "YYYY-MM-DD". */
export function hoyISO(): string {
  return fechaLocalISO(new Date());
}

/** "HH:mm" (24 h, como lo guarda y devuelve el sistema) -> "h:mm AM/PM" (12 h,
 * como se muestra a clientes y administradores). "09:00" -> "9:00 AM",
 * "13:30" -> "1:30 PM", "00:15" -> "12:15 AM", "12:00" -> "12:00 PM". Un valor
 * vacio o que no es una hora se devuelve tal cual. */
export function formatoHora12(hora: string): string {
  const coincidencia = /^(\d{1,2}):(\d{2})$/.exec(hora);
  if (!coincidencia) return hora;
  const horas = Number(coincidencia[1]);
  if (horas > 23) return hora;
  const periodo = horas < 12 ? "AM" : "PM";
  const horas12 = horas % 12 === 0 ? 12 : horas % 12;
  return `${horas12}:${coincidencia[2]} ${periodo}`;
}

/** "09:00", "09:30" -> "9:00 AM – 9:30 AM". */
export function formatoRangoHora12(inicio: string, fin: string): string {
  return `${formatoHora12(inicio)} – ${formatoHora12(fin)}`;
}

function aMinutos(hora: string): number {
  const [horas, minutos] = hora.split(":").map(Number);
  return (horas ?? 0) * 60 + (minutos ?? 0);
}

export interface HorarioReserva {
  readonly horaInicio: string;
  readonly horaFin: string;
}

/** true si el rango [horaInicio, horaFin) se cruza con la hora de reloj en
 * curso (a las 11:20, el bloque 11:00-12:00): cubre tanto un horario que
 * empieza mas tarde dentro de esa hora como uno que ya empezo y sigue. */
export function horarioEnHoraActual(horario: HorarioReserva, ahora: Date): boolean {
  const inicioHoraActual = ahora.getHours() * 60;
  const finHoraActual = inicioHoraActual + 60;
  return aMinutos(horario.horaInicio) < finHoraActual && aMinutos(horario.horaFin) > inicioHoraActual;
}

/** true si la reserva es de hoy y alguno de sus horarios cae en la hora actual
 * (se usa para resaltarla en la lista del administrador). */
export function reservaEnHoraActual(
  reserva: { readonly fecha: string; readonly horarios: readonly HorarioReserva[] },
  ahora: Date,
): boolean {
  return fechaLocalISO(ahora) === reserva.fecha && reserva.horarios.some((h) => horarioEnHoraActual(h, ahora));
}
