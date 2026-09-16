// ============================================================================
// Vista operativa de un dia para el panel administrativo (14.2).
//
// NO reimplementa nada del motor de disponibilidad ni de bloqueos: reutiliza
// resolverVentanasDelDia (availability.service.ts, misma resolucion de
// apertura/almuerzo que ya usa el motor) y listarBloqueos
// (bloqueos.service.ts, 14.4). Lo unico nuevo aqui es armar el arbol
// lotes -> heats -> reservas que la pantalla de calendario necesita para
// diferenciar visualmente heat con capacidad / completo / reserva temporal /
// confirmada, y para el detalle al seleccionar un lote o un heat.
// ============================================================================

import type { PrismaClient } from "@prisma/client";
import { listarBloqueos, type BloqueoPublico } from "./bloqueos.service.js";
import { resolverVentanasDelDia, type VentanaHoraria } from "./availability.service.js";
import { fechaISOaDate } from "./availability.service.js";
import { CAPACIDAD_MAXIMA_POR_HEAT, type FechaISO, type HoraISO, type IdServicio } from "../motor-disponibilidad/motor-disponibilidad.js";

export interface ReservaDeHeat {
  readonly codigoPublico: string;
  readonly cantidadPersonas: number;
  readonly estado: string;
}

export interface HeatOperativo {
  readonly heatId: string;
  readonly horaInicio: HoraISO;
  readonly horaFin: HoraISO;
  readonly capacidadMaxima: number;
  readonly reservas: readonly ReservaDeHeat[];
}

export interface LoteOperativo {
  readonly loteId: string;
  readonly horaInicio: HoraISO;
  readonly horaFinUltimoHeat: HoraISO;
  readonly horaInicioLimpieza: HoraISO;
  readonly horaFinLimpieza: HoraISO;
  readonly heats: readonly HeatOperativo[];
}

export interface CalendarioOperativoDelDia {
  /** Vacio si el dia esta cerrado por completo (sin plantilla activa ni excepcion). */
  readonly ventanas: readonly VentanaHoraria[];
  readonly lotes: readonly LoteOperativo[];
  readonly bloqueos: readonly BloqueoPublico[];
}

/**
 * Calendario operativo de un dia puntual (14.2): lotes con sus heats
 * (capacidad y las reservas ACTIVAS que comparte cada uno), la ventana
 * horaria del dia y los bloqueos administrativos.
 */
export async function calendarioOperativoDelDia(
  prisma: PrismaClient,
  servicioId: IdServicio,
  fecha: FechaISO,
): Promise<CalendarioOperativoDelDia> {
  const [ventanas, heats, bloqueos] = await Promise.all([
    resolverVentanasDelDia(prisma, servicioId, fecha),
    prisma.heat.findMany({
      where: { servicioId, fecha: fechaISOaDate(fecha) },
      orderBy: { horaInicio: "asc" },
      include: {
        lote: true,
        asignaciones: {
          where: { estado: "ACTIVA" },
          include: { reservation: { select: { codigoPublico: true, estado: true } } },
        },
      },
    }),
    listarBloqueos(prisma, servicioId, fecha),
  ]);

  const infoLotePorId = new Map<string, Omit<LoteOperativo, "heats">>();
  const heatsPorLote = new Map<string, HeatOperativo[]>();

  for (const heat of heats) {
    if (!infoLotePorId.has(heat.loteId)) {
      infoLotePorId.set(heat.loteId, {
        loteId: heat.loteId,
        horaInicio: heat.lote.horaInicio as HoraISO,
        horaFinUltimoHeat: heat.lote.horaFinUltimoHeat as HoraISO,
        horaInicioLimpieza: heat.lote.horaInicioLimpieza as HoraISO,
        horaFinLimpieza: heat.lote.horaFinLimpieza as HoraISO,
      });
    }
    const heatsDelLote = heatsPorLote.get(heat.loteId) ?? [];
    heatsDelLote.push({
      heatId: heat.id,
      horaInicio: heat.horaInicio as HoraISO,
      horaFin: heat.horaFin as HoraISO,
      capacidadMaxima: CAPACIDAD_MAXIMA_POR_HEAT,
      reservas: heat.asignaciones.map((asignacion) => ({
        codigoPublico: asignacion.reservation.codigoPublico,
        cantidadPersonas: asignacion.cantidadParticipantes,
        estado: asignacion.reservation.estado,
      })),
    });
    heatsPorLote.set(heat.loteId, heatsDelLote);
  }

  const lotes = Array.from(infoLotePorId.values())
    .map((info) => ({ ...info, heats: heatsPorLote.get(info.loteId) ?? [] }))
    .sort((a, b) => a.horaInicio.localeCompare(b.horaInicio));

  return { ventanas, lotes, bloqueos };
}
