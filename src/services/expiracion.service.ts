// ============================================================================
// Servicio de expiracion de reservas temporales (11.2, 19.1, 6.7.6-8).
//
// Busca reservas TEMPORAL cuyo `expiraEn` ya paso, las marca EXPIRADA,
// libera sus asignaciones y normaliza los lotes afectados con el motor puro
// `normalizarLoteTrasLiberacion` (../motor-disponibilidad/motor-disponibilidad).
// Este archivo NO reimplementa esa logica: solo lee el estado actual de cada
// lote afectado, invoca al motor y aplica el resultado.
//
// Cada reserva vencida se procesa en su PROPIA transaccion, bloqueando la
// fila con SELECT ... FOR UPDATE antes de actuar (mismo patron que
// availability.service.ts): asi una reserva no bloquea el procesamiento de
// las demas, y si el cliente la confirma justo en el instante en que el
// worker la revisa, la revalidacion bajo lock detecta que ya no califica y
// no hace nada (idempotente).
//
// Fuera de alcance deliberado (igual que availability.service.ts, "16.1
// alcance deliberado"): registro de auditoria (no existe AuditEvent
// todavia) y notificaciones. El disparador del worker (cron, scheduler,
// endpoint interno) tampoco vive aqui: esta funcion solo hace el trabajo de
// una "pasada"; a que ritmo se llama es una decision de infraestructura de
// la Etapa 4 del plan de implementacion.
// ============================================================================

import { Prisma, PrismaClient } from "@prisma/client";
import {
  normalizarLoteTrasLiberacion,
  type HeatParaNormalizar,
  type IdLote,
} from "../motor-disponibilidad/motor-disponibilidad.js";

export interface ResultadoExpiracion {
  readonly reservationId: string;
  /** false si, bajo lock, la reserva ya no calificaba para vencer (el
   * cliente la confirmo, la cancelo, o ya la habia expirado un intento
   * anterior) y no se hizo nada. */
  readonly expirada: boolean;
}

/**
 * Busca todas las reservas TEMPORAL cuyo plazo ya vencio y las expira una
 * por una (19.1). Pensada para llamarse periodicamente desde un
 * worker/cron externo; cada llamada procesa una "pasada" completa.
 */
export async function expirarReservasVencidas(
  prisma: PrismaClient,
  ahora: Date = new Date(),
): Promise<readonly ResultadoExpiracion[]> {
  const vencidas = await prisma.reservation.findMany({
    where: { estado: "TEMPORAL", expiraEn: { lte: ahora } },
    select: { id: true },
  });

  const resultados: ResultadoExpiracion[] = [];
  for (const { id } of vencidas) {
    resultados.push(await expirarUnaReserva(prisma, id, ahora));
  }
  return resultados;
}

/**
 * Expira una reserva puntual dentro de su propia transaccion. Se exporta
 * aparte de `expirarReservasVencidas` para poder expirar una reserva
 * concreta bajo demanda (por ejemplo, al detectar en el panel administrativo
 * que una reserva TEMPORAL ya supero su plazo antes de que pase el worker).
 */
export async function expirarUnaReserva(
  prisma: PrismaClient,
  reservationId: string,
  ahora: Date = new Date(),
): Promise<ResultadoExpiracion> {
  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "reservations" WHERE id = ${reservationId} FOR UPDATE`;

    const reserva = await tx.reservation.findUnique({ where: { id: reservationId } });
    if (
      !reserva ||
      reserva.estado !== "TEMPORAL" ||
      reserva.expiraEn === null ||
      reserva.expiraEn > ahora
    ) {
      return { reservationId, expirada: false };
    }

    await tx.reservation.update({
      where: { id: reservationId },
      data: { estado: "EXPIRADA" },
    });

    await liberarAsignacionesYNormalizarLotes(tx, reservationId, ahora);

    return { reservationId, expirada: true };
  });
}

/**
 * Libera (marca LIBERADA) todas las asignaciones ACTIVA de una reserva y
 * normaliza los lotes que quedaron afectados (6.7.6-8). Reutilizada tanto al
 * vencer una reserva (arriba) como al cancelarla o reprogramarla
 * (gestion-reservas.service.ts, 14.5/14.6): en los tres casos la reserva deja
 * de ocupar esos heats y el lote debe recalcularse de la misma forma. NO
 * cambia el estado de la propia reserva — eso lo decide cada llamador antes
 * o despues, segun su propio flujo.
 */
export async function liberarAsignacionesYNormalizarLotes(
  tx: Prisma.TransactionClient,
  reservationId: string,
  ahora: Date,
): Promise<void> {
  const asignacionesActivas = await tx.heatAllocation.findMany({
    where: { reservationId, estado: "ACTIVA" },
  });
  if (asignacionesActivas.length === 0) return;

  await tx.heatAllocation.updateMany({
    where: { reservationId, estado: "ACTIVA" },
    data: { estado: "LIBERADA", liberadoEn: ahora },
  });

  const loteIdsAfectados = new Set<IdLote>();
  for (const asignacion of asignacionesActivas) {
    const heat = await tx.heat.findUnique({ where: { id: asignacion.heatId } });
    if (heat) loteIdsAfectados.add(heat.loteId);
  }

  for (const loteId of loteIdsAfectados) {
    await normalizarUnLote(tx, loteId);
  }
}

/** Recalcula el estado de un lote a partir de sus asignaciones ACTIVA
 * restantes (tras la liberacion recien aplicada) y ejecuta el resultado del
 * motor puro `normalizarLoteTrasLiberacion` (6.7.6-8).
 *
 * Bloquea el lote y sus heats ANTES de leer su ocupacion (mismo patron que
 * `bloquearFilasInvolucradas` en availability.service.ts, 8.8): sin este
 * lock, una `confirmarReserva` concurrente podria tomar `FOR UPDATE` sobre
 * este mismo heat, insertar una asignacion nueva y comitear en la ventana
 * entre nuestra lectura (que lo vio vacio) y nuestro `heat.delete` /
 * `operationalBatch.delete` — borrando por cascada esa asignacion recien
 * creada sin que nadie lo note.
 *
 * Exportada: `gestion-reservas.service.ts` (14.6) la reutiliza al
 * reprogramar, donde solo se liberan las asignaciones ANTERIORES de la
 * reserva (no las recien creadas por el nuevo plan), asi que no puede usar
 * `liberarAsignacionesYNormalizarLotes` (que libera TODO lo ACTIVA de la
 * reserva) y necesita este paso mas fino directamente. */
export async function normalizarUnLote(tx: Prisma.TransactionClient, loteId: IdLote): Promise<void> {
  await tx.$queryRaw`SELECT id FROM "operational_batches" WHERE id = ${loteId} FOR UPDATE`;
  await tx.$queryRaw`SELECT id FROM "heats" WHERE lote_id = ${loteId} FOR UPDATE`;

  const heatsDelLote = await tx.heat.findMany({
    where: { loteId },
    orderBy: { posicionEnLote: "asc" },
    include: { asignaciones: { where: { estado: "ACTIVA" } } },
  });

  const heatsParaNormalizar: HeatParaNormalizar[] = heatsDelLote.map((h) => ({
    heatId: h.id,
    posicionEnLote: h.posicionEnLote,
    horaInicio: h.horaInicio,
    horaFin: h.horaFin,
    quedaVacio: h.asignaciones.length === 0,
  }));

  const resultado = normalizarLoteTrasLiberacion({ loteId, heats: heatsParaNormalizar });

  if (resultado.accion === "sin_cambios") {
    return;
  }

  if (resultado.accion === "eliminar_lote") {
    // onDelete: Cascade (schema.prisma) se encarga de sus Heat/HeatAllocation.
    await tx.operationalBatch.delete({ where: { id: loteId } });
    return;
  }

  // recortar_lote: se borran los heats vacios de los extremos, se renumeran
  // los que quedan y se reposiciona la limpieza del lote (6.7.8).
  for (const heatId of resultado.heatIdsAEliminar) {
    await tx.heat.delete({ where: { id: heatId } });
  }
  for (const { heatId, nuevaPosicionEnLote } of resultado.heatsConservados) {
    await tx.heat.update({ where: { id: heatId }, data: { posicionEnLote: nuevaPosicionEnLote } });
  }
  await tx.operationalBatch.update({
    where: { id: loteId },
    data: {
      horaInicio: resultado.horaInicio,
      horaFinUltimoHeat: resultado.horaFinUltimoHeat,
      horaInicioLimpieza: resultado.horaInicioLimpieza,
      horaFinLimpieza: resultado.horaFinLimpieza,
      cantidadHeats: resultado.cantidadHeats,
    },
  });
}
