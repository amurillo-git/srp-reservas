// ============================================================================
// Servicio de bloqueos administrativos (14.4, ejemplo 9.22).
//
// Un bloqueo NO puede cancelar silenciosamente reservas existentes: si el
// rango solicitado se solapa con heats que tienen participantes activos
// (confirmados, o retenidos por un TEMPORAL vigente / SINPE pendiente, mismo
// criterio de 6.5), `crearBloqueo` devuelve la lista de reservas en
// conflicto y NO crea nada, salvo que se pida explicitamente `forzar` (9.22:
// "exigir una confirmacion explicita... solicitar un motivo").
//
// Fuera de alcance deliberado: cancelar o reprogramar automaticamente las
// reservas en conflicto (14.5-14.6, otra slice) y notificar al cliente.
// ============================================================================

import type { PrismaClient } from "@prisma/client";
import { horaAMinutos, type FechaISO, type HoraISO, type IdServicio } from "../motor-disponibilidad/motor-disponibilidad.js";

/** Estados de reserva cuyos participantes cuentan como ocupacion real (6.5):
 * confirmados siempre, TEMPORAL solo si su plazo no ha vencido, y SINPE
 * pendiente de validacion siempre (6.9.5). RECHAZADA/CANCELADA/EXPIRADA no
 * bloquean un nuevo bloqueo. */
function reservaOcupaCapacidad(estado: string, expiraEn: Date | null, ahora: Date): boolean {
  if (estado === "CONFIRMADA" || estado === "PENDIENTE_VALIDACION_SINPE") return true;
  if (estado === "TEMPORAL") return expiraEn === null || expiraEn > ahora;
  return false;
}

function fechaISOaDate(fecha: FechaISO): Date {
  return new Date(`${fecha}T00:00:00.000Z`);
}

export interface SolicitudBloqueo {
  readonly servicioId: IdServicio;
  readonly fecha: FechaISO;
  readonly horaInicio: HoraISO;
  readonly horaFin: HoraISO;
  readonly motivo?: string;
  /** true si el administrador ya vio el conflicto (respuesta previa de esta
   * misma funcion) y confirma crear el bloqueo de todas formas (9.22). */
  readonly forzar?: boolean;
}

export interface ReservaEnConflicto {
  readonly codigoPublico: string;
  readonly estado: string;
  readonly cantidadPersonas: number;
}

export type ResultadoCrearBloqueo =
  | { readonly ok: true; readonly bloqueoId: string }
  | { readonly ok: false; readonly motivo: "CONFLICTO"; readonly reservasEnConflicto: readonly ReservaEnConflicto[] };

export async function crearBloqueo(
  prisma: PrismaClient,
  solicitud: SolicitudBloqueo,
  ahora: Date = new Date(),
): Promise<ResultadoCrearBloqueo> {
  const fechaDate = fechaISOaDate(solicitud.fecha);
  const inicioMin = horaAMinutos(solicitud.horaInicio);
  const finMin = horaAMinutos(solicitud.horaFin);

  const heatsDelDia = await prisma.heat.findMany({
    where: { servicioId: solicitud.servicioId, fecha: fechaDate },
    include: {
      asignaciones: {
        where: { estado: "ACTIVA" },
        include: {
          reservation: { select: { id: true, codigoPublico: true, estado: true, cantidadPersonas: true, expiraEn: true } },
        },
      },
    },
  });

  const reservasEnConflicto = new Map<string, ReservaEnConflicto>();
  for (const heat of heatsDelDia) {
    const heatInicio = horaAMinutos(heat.horaInicio);
    const heatFin = horaAMinutos(heat.horaFin);
    const seSolapa = heatInicio < finMin && inicioMin < heatFin;
    if (!seSolapa) continue;

    for (const asignacion of heat.asignaciones) {
      const r = asignacion.reservation;
      if (!reservaOcupaCapacidad(r.estado, r.expiraEn, ahora)) continue;
      reservasEnConflicto.set(r.id, {
        codigoPublico: r.codigoPublico,
        estado: r.estado,
        cantidadPersonas: r.cantidadPersonas,
      });
    }
  }

  const listaConflictos = [...reservasEnConflicto.values()];
  if (listaConflictos.length > 0 && !solicitud.forzar) {
    return { ok: false, motivo: "CONFLICTO", reservasEnConflicto: listaConflictos };
  }

  const bloqueo = await prisma.administrativeBlock.create({
    data: {
      servicioId: solicitud.servicioId,
      fecha: fechaDate,
      horaInicio: solicitud.horaInicio,
      horaFin: solicitud.horaFin,
      motivo: solicitud.motivo,
    },
  });
  return { ok: true, bloqueoId: bloqueo.id };
}

export interface BloqueoPublico {
  readonly id: string;
  readonly fecha: FechaISO;
  readonly horaInicio: HoraISO;
  readonly horaFin: HoraISO;
  readonly motivo: string | null;
}

function dateAFechaISO(fecha: Date): FechaISO {
  return fecha.toISOString().slice(0, 10);
}

export async function listarBloqueos(
  prisma: PrismaClient,
  servicioId: IdServicio,
  fecha: FechaISO,
): Promise<readonly BloqueoPublico[]> {
  const bloqueos = await prisma.administrativeBlock.findMany({
    where: { servicioId, fecha: fechaISOaDate(fecha) },
  });
  return bloqueos.map((b) => ({
    id: b.id,
    fecha: dateAFechaISO(b.fecha),
    horaInicio: b.horaInicio as HoraISO,
    horaFin: b.horaFin as HoraISO,
    motivo: b.motivo,
  }));
}

export type ResultadoEliminarBloqueo = { readonly ok: true } | { readonly ok: false; readonly motivo: "NO_ENCONTRADO" };

export async function eliminarBloqueo(prisma: PrismaClient, id: string): Promise<ResultadoEliminarBloqueo> {
  try {
    await prisma.administrativeBlock.delete({ where: { id } });
    return { ok: true };
  } catch {
    return { ok: false, motivo: "NO_ENCONTRADO" };
  }
}
