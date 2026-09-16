// ============================================================================
// Servicio de gestion de reservas desde el panel administrativo (14.5-14.6).
//
// Cancelacion y reprogramacion. NO reimplementa el motor de disponibilidad
// ni la persistencia de un plan: reutiliza `calcularYBloquearPlanFinal` y
// `persistirPlanParaReserva` de availability.service.ts (las mismas piezas
// que usa `confirmarReserva`) y `normalizarUnLote`/
// `liberarAsignacionesYNormalizarLotes` de expiracion.service.ts (las mismas
// que liberan capacidad al vencer una reserva). Fuera de alcance deliberado
// de esta slice (quedan para otras): busqueda/listado de reservas, creacion
// manual desde el panel, reenvio de confirmacion (notificaciones, seccion
// 15), notas internas, marcar completada/no-presentada.
// ============================================================================

import { PrismaClient } from "@prisma/client";
import {
  calcularYBloquearPlanFinal,
  ConflictoBloqueoInestable,
  esViolacionUnica,
  fechaISOaDate,
  ocultarLimpieza,
  persistirPlanParaReserva,
  RESTRICCION_HEAT_UNICO,
  type PlanDisponiblePublico,
  type SolicitudConsultarDisponibilidad,
} from "./availability.service.js";
import { liberarAsignacionesYNormalizarLotes, normalizarUnLote } from "./expiracion.service.js";
import type { FechaISO, HoraISO } from "../motor-disponibilidad/motor-disponibilidad.js";

// ----------------------------------------------------------------------------
// Cancelacion (14.5).
// ----------------------------------------------------------------------------

/** Estados desde los que una reserva puede cancelarse: cualquiera que aun
 * ocupe o pueda llegar a ocupar capacidad (6.5). Ya terminales
 * (RECHAZADA/CANCELADA/EXPIRADA) no se pueden volver a cancelar. */
const ESTADOS_CANCELABLES = new Set(["TEMPORAL", "PENDIENTE_VALIDACION_SINPE", "CONFIRMADA"]);

export type ResultadoCancelacion =
  | { readonly ok: true }
  | { readonly ok: false; readonly motivo: "NO_ENCONTRADA" }
  | { readonly ok: false; readonly motivo: "ESTADO_INVALIDO"; readonly estadoActual: string };

/**
 * Cancela una reserva: la marca CANCELADA, libera sus asignaciones activas y
 * normaliza los lotes que queden afectados (mismo motor que la expiracion).
 * Idempotente en el sentido de que una reserva ya terminal no se puede volver
 * a cancelar (devuelve ESTADO_INVALIDO en vez de silenciarlo).
 */
export async function cancelarReserva(
  prisma: PrismaClient,
  codigoPublico: string,
  ahora: Date = new Date(),
): Promise<ResultadoCancelacion> {
  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "reservations" WHERE public_code = ${codigoPublico} FOR UPDATE`;

    const reserva = await tx.reservation.findUnique({ where: { codigoPublico } });
    if (!reserva) {
      return { ok: false, motivo: "NO_ENCONTRADA" };
    }
    if (!ESTADOS_CANCELABLES.has(reserva.estado)) {
      return { ok: false, motivo: "ESTADO_INVALIDO", estadoActual: reserva.estado };
    }

    await tx.reservation.update({
      where: { id: reserva.id },
      data: { estado: "CANCELADA", canceladaEn: ahora },
    });

    await liberarAsignacionesYNormalizarLotes(tx, reserva.id, ahora);

    return { ok: true };
  });
}

// ----------------------------------------------------------------------------
// Reprogramacion (14.6). Tambien cubre "modificar cantidad de personas con
// revalidacion completa" (14.5): es el mismo caso con fecha/hora iguales.
// ----------------------------------------------------------------------------

/** Solo reservas ya en un estado de compromiso real se reprograman: una
 * TEMPORAL sin pagar es mas simple cancelarla y volver a reservar. */
const ESTADOS_REPROGRAMABLES = new Set(["CONFIRMADA", "PENDIENTE_VALIDACION_SINPE"]);

export interface SolicitudReprogramarReserva {
  readonly fecha: FechaISO;
  readonly horaInicioCandidata: HoraISO;
  readonly cantidadPersonas: number;
}

export type ResultadoReprogramacion =
  | { readonly ok: true; readonly plan: PlanDisponiblePublico }
  | { readonly ok: false; readonly motivo: "NO_ENCONTRADA" }
  | { readonly ok: false; readonly motivo: "ESTADO_INVALIDO"; readonly estadoActual: string }
  | { readonly ok: false; readonly motivo: "NO_DISPONIBLE" }
  | { readonly ok: false; readonly motivo: "CONFLICTO_CONCURRENCIA"; readonly detalle: string };

/**
 * Reprograma (o redimensiona) una reserva de forma atomica (14.6):
 *
 * 1. Calcula y bloquea el nuevo plan, EXCLUYENDO las propias asignaciones
 *    activas de esta reserva de la ocupacion (si no, reprogramar hacia el
 *    mismo horario o uno solapado se autobloquearia).
 * 2. Retiene (persiste) el plan nuevo.
 * 3. Libera las asignaciones ANTERIORES (no las recien creadas) y normaliza
 *    los lotes que queden afectados.
 * 4. Actualiza fecha/cantidadPersonas/montos de la reserva.
 *
 * Todo dentro de una unica transaccion: si algo falla en cualquier paso, la
 * transaccion completa revierte y la reserva original queda intacta — la
 * misma garantia que 14.6 pide con "no liberar antes de tener lo nuevo", que
 * aqui provee el ROLLBACK de la base de datos en vez de un orden manual de
 * pasos entre sistemas separados.
 */
export async function reprogramarReserva(
  prisma: PrismaClient,
  codigoPublico: string,
  nuevaSolicitud: SolicitudReprogramarReserva,
  intentosMaximos = 3,
): Promise<ResultadoReprogramacion> {
  for (let intento = 1; intento <= intentosMaximos; intento++) {
    try {
      return await prisma.$transaction(
        async (tx) => {
          await tx.$queryRaw`SELECT id FROM "reservations" WHERE public_code = ${codigoPublico} FOR UPDATE`;

          const reserva = await tx.reservation.findUnique({ where: { codigoPublico } });
          if (!reserva) {
            return { ok: false, motivo: "NO_ENCONTRADA" };
          }
          if (!ESTADOS_REPROGRAMABLES.has(reserva.estado)) {
            return { ok: false, motivo: "ESTADO_INVALIDO", estadoActual: reserva.estado };
          }

          const asignacionesAnteriores = await tx.heatAllocation.findMany({
            where: { reservationId: reserva.id, estado: "ACTIVA" },
          });

          const solicitudPlan: SolicitudConsultarDisponibilidad = {
            servicioId: reserva.servicioId,
            fecha: nuevaSolicitud.fecha,
            horaInicioCandidata: nuevaSolicitud.horaInicioCandidata,
            cantidadPersonas: nuevaSolicitud.cantidadPersonas,
          };
          const resultado = await calcularYBloquearPlanFinal(tx, solicitudPlan, reserva.id);
          if (!resultado.disponible) {
            return { ok: false, motivo: "NO_DISPONIBLE" };
          }
          const planFinal = resultado.plan;

          // 1) Retener el nuevo plan ANTES de liberar el anterior.
          await persistirPlanParaReserva(tx, reserva.servicioId, nuevaSolicitud.fecha, reserva.id, planFinal);

          // 2) Liberar EXACTAMENTE las asignaciones anteriores (no las recien
          // creadas arriba, que tambien quedan ACTIVA para esta reserva) y
          // normalizar los lotes que hayan quedado afectados.
          const ahora = new Date();
          const loteIdsAfectados = new Set<string>();
          for (const asignacion of asignacionesAnteriores) {
            await tx.heatAllocation.update({
              where: { id: asignacion.id },
              data: { estado: "LIBERADA", liberadoEn: ahora },
            });
            const heat = await tx.heat.findUnique({ where: { id: asignacion.heatId } });
            if (heat) loteIdsAfectados.add(heat.loteId);
          }
          for (const loteId of loteIdsAfectados) {
            await normalizarUnLote(tx, loteId);
          }

          // 3) Revalidacion completa de precio/cantidad (14.5).
          await tx.reservation.update({
            where: { id: reserva.id },
            data: {
              fecha: fechaISOaDate(nuevaSolicitud.fecha),
              cantidadPersonas: nuevaSolicitud.cantidadPersonas,
              moneda: planFinal.precio?.moneda ?? reserva.moneda,
              montoTotal: planFinal.precio?.montoTotal ?? reserva.montoTotal,
              montoDeposito: planFinal.precio?.montoDeposito ?? reserva.montoDeposito,
              montoSaldo: planFinal.precio?.montoSaldo ?? reserva.montoSaldo,
              // 25.8: contador minimo para el reporte de reprogramaciones,
              // sin necesitar un historial de auditoria completo.
              vecesReprogramada: { increment: 1 },
            },
          });

          return { ok: true, plan: ocultarLimpieza(planFinal) };
        },
        { maxWait: 5_000, timeout: 10_000 },
      );
    } catch (error) {
      // Mismo tratamiento que confirmarReserva (8.8.6): otra transaccion
      // gano la carrera por un heat nuevo, o el bloqueo no se estabilizo:
      // reintentar con contexto fresco; agotados los intentos, conflicto.
      const esConflictoDeCapacidad = esViolacionUnica(error, RESTRICCION_HEAT_UNICO);
      if (esConflictoDeCapacidad || error instanceof ConflictoBloqueoInestable) {
        if (intento < intentosMaximos) continue;
        return {
          ok: false,
          motivo: "CONFLICTO_CONCURRENCIA",
          detalle: "La disponibilidad cambio mientras se procesaba la reprogramacion.",
        };
      }
      throw error;
    }
  }

  return {
    ok: false,
    motivo: "CONFLICTO_CONCURRENCIA",
    detalle: "No se pudo reprogramar tras varios intentos por alta concurrencia.",
  };
}
