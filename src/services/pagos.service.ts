// ============================================================================
// Servicio de pagos — SINPE manual (6.9, 11.3, 12.2).
//
// El pago con tarjeta NO vive aqui: el proveedor todavia no esta seleccionado
// (13.2, "queda pendiente de seleccion"). Este archivo cubre unicamente el
// flujo SINPE, que no depende de ningun proveedor externo: reportar el
// comprobante (11.3) y la aprobacion/rechazo administrativa (6.9.6-8).
//
// Cada operacion bloquea la fila de la reserva (SELECT ... FOR UPDATE) antes
// de leer y validar su estado, mismo patron que availability.service.ts y
// expiracion.service.ts: sin ese lock, dos acciones concurrentes sobre la
// misma reserva (ej. el worker de expiracion y una aprobacion administrativa
// llegando casi al mismo tiempo) podrian pisarse una a la otra.
// ============================================================================

import { Prisma, PrismaClient } from "@prisma/client";

/** Bloquea la reserva por su codigo publico y devuelve su estado FRESCO bajo
 * el lock (o `null` si no existe). Debe llamarse dentro de una transaccion. */
async function bloquearYLeerReserva(tx: Prisma.TransactionClient, codigoPublico: string) {
  const previa = await tx.reservation.findUnique({ where: { codigoPublico } });
  if (!previa) return null;
  await tx.$queryRaw`SELECT id FROM "reservations" WHERE id = ${previa.id} FOR UPDATE`;
  return tx.reservation.findUnique({ where: { id: previa.id } });
}

export interface ComprobanteSinpe {
  readonly comprobanteUrl?: string;
  readonly nombrePagador?: string;
  readonly numeroOrigen?: string;
  readonly referencia?: string;
}

export type MotivoRechazoReporteSinpe = "NO_ENCONTRADA" | "ESTADO_INVALIDO" | "VENCIDA";

export type ResultadoReportarSinpe =
  | { readonly ok: true }
  | { readonly ok: false; readonly motivo: MotivoRechazoReporteSinpe };

/**
 * Reporta el comprobante SINPE de una reserva TEMPORAL antes de que venza
 * (11.3, 6.9.1-4). Cambia el estado a PENDIENTE_VALIDACION_SINPE, lo que en
 * la practica suspende el vencimiento automatico: `expirarReservasVencidas`
 * (expiracion.service.ts) solo busca reservas en estado TEMPORAL, asi que a
 * partir de aqui el worker las ignora (6.9.5: "la capacidad permanecera
 * retenida sin depender del temporizador inicial").
 */
export async function reportarComprobanteSinpe(
  prisma: PrismaClient,
  codigoPublico: string,
  comprobante: ComprobanteSinpe,
): Promise<ResultadoReportarSinpe> {
  return prisma.$transaction(async (tx) => {
    const reserva = await bloquearYLeerReserva(tx, codigoPublico);
    if (!reserva) return { ok: false, motivo: "NO_ENCONTRADA" };
    if (reserva.estado !== "TEMPORAL") return { ok: false, motivo: "ESTADO_INVALIDO" };
    if (reserva.expiraEn !== null && reserva.expiraEn <= new Date()) {
      return { ok: false, motivo: "VENCIDA" };
    }

    await tx.reservation.update({
      where: { id: reserva.id },
      data: { estado: "PENDIENTE_VALIDACION_SINPE" },
    });
    await tx.sinpeEvidence.create({
      data: {
        reservationId: reserva.id,
        comprobanteUrl: comprobante.comprobanteUrl,
        nombrePagador: comprobante.nombrePagador,
        numeroOrigen: comprobante.numeroOrigen,
        referencia: comprobante.referencia,
      },
    });
    return { ok: true };
  });
}

export type MotivoRechazoValidacionSinpe = "NO_ENCONTRADA" | "ESTADO_INVALIDO" | "MONTO_INVALIDO";

export type ResultadoValidarSinpe =
  | { readonly ok: true }
  | { readonly ok: false; readonly motivo: MotivoRechazoValidacionSinpe };

/**
 * Aprueba un deposito SINPE pendiente de validacion (6.9.6-7): confirma la
 * reserva. Solo procede si el estado ACTUAL (bajo lock) sigue siendo
 * PENDIENTE_VALIDACION_SINPE.
 *
 * `montoPagado` (28): el admin puede indicar que el comprobante es por un
 * monto distinto al depositado esperado (el cliente deposito de mas o de
 * menos). Si se omite, se asume que se pago exactamente el deposito
 * calculado (comportamiento previo). Cuando se indica, ese monto pasa a ser
 * el "deposito pagado" de la reserva y el saldo pendiente se recalcula
 * (montoTotal - montoPagado, nunca negativo: no hay creditos a favor).
 */
export async function aprobarSinpe(
  prisma: PrismaClient,
  codigoPublico: string,
  montoPagado?: number,
): Promise<ResultadoValidarSinpe> {
  if (montoPagado !== undefined && !(montoPagado > 0)) {
    return { ok: false, motivo: "MONTO_INVALIDO" };
  }

  return prisma.$transaction(async (tx) => {
    const reserva = await bloquearYLeerReserva(tx, codigoPublico);
    if (!reserva) return { ok: false, motivo: "NO_ENCONTRADA" };
    if (reserva.estado !== "PENDIENTE_VALIDACION_SINPE") return { ok: false, motivo: "ESTADO_INVALIDO" };

    const confirmadaEn = new Date();
    const montoDeposito = montoPagado ?? Number(reserva.montoDeposito);
    const montoSaldo = Math.max(0, Number(reserva.montoTotal) - montoDeposito);
    await tx.reservation.update({
      where: { id: reserva.id },
      data: { estado: "CONFIRMADA", confirmadaEn, montoDeposito, montoSaldo },
    });
    // 25: registra el cobro en el ledger de Payment, ademas de confirmar la
    // reserva.
    await tx.payment.create({
      data: {
        reservationId: reserva.id,
        tipo: "DEPOSITO",
        monto: montoDeposito,
        moneda: reserva.moneda,
        metodo: "SINPE_MANUAL",
        estado: "PAGADO",
        pagadoEn: confirmadaEn,
      },
    });
    return { ok: true };
  });
}

/**
 * Rechaza un deposito SINPE pendiente de validacion, con motivo obligatorio
 * (6.9.8). El MVP no implementa todavia "conceder un nuevo plazo" (esa misma
 * regla lo menciona como alternativa al rechazo) ni la reprogramacion; una
 * reserva rechazada queda en RECHAZADA hasta una accion administrativa
 * futura fuera de esta slice.
 */
export async function rechazarSinpe(
  prisma: PrismaClient,
  codigoPublico: string,
  motivo: string,
): Promise<ResultadoValidarSinpe> {
  return prisma.$transaction(async (tx) => {
    const reserva = await bloquearYLeerReserva(tx, codigoPublico);
    if (!reserva) return { ok: false, motivo: "NO_ENCONTRADA" };
    if (reserva.estado !== "PENDIENTE_VALIDACION_SINPE") return { ok: false, motivo: "ESTADO_INVALIDO" };

    await tx.reservation.update({
      where: { id: reserva.id },
      data: { estado: "RECHAZADA", motivoRechazo: motivo, rechazadaEn: new Date() },
    });
    return { ok: true };
  });
}
