// ============================================================================
// Cobro de saldo al llegar al Race Park (25). Una reserva CONFIRMADA (deposito
// pagado) puede pasar a PAGADA por tres vias: SINPE manual (un clic, sin
// revision posterior porque el staff esta cara a cara con el cliente y ya
// verifico la transferencia), SINPE automatico via ONVO (pago-sinpe-onvo.service.ts)
// o tarjeta (pago-tarjeta.service.ts). Este archivo cubre unicamente la via
// manual; las otras dos reutilizan sus servicios existentes con tipo "SALDO".
// ============================================================================

import { Prisma, PrismaClient } from "@prisma/client";
import { obtenerModoSinpe } from "./configuracion-pago.service.js";

async function bloquearYLeerReservaPorCodigo(tx: Prisma.TransactionClient, codigoPublico: string) {
  const previa = await tx.reservation.findUnique({ where: { codigoPublico } });
  if (!previa) return null;
  await tx.$queryRaw`SELECT id FROM "reservations" WHERE id = ${previa.id} FOR UPDATE`;
  return tx.reservation.findUnique({ where: { id: previa.id } });
}

export type MotivoRechazoCobroSaldo = "NO_ENCONTRADA" | "ESTADO_INVALIDO" | "MODO_INCORRECTO";

export type ResultadoCobroSaldo =
  | { readonly ok: true }
  | { readonly ok: false; readonly motivo: MotivoRechazoCobroSaldo };

/**
 * Marca el saldo como pagado manualmente (25): un solo clic, sin proceso de
 * revision posterior. A diferencia del deposito remoto (que llega de forma
 * asincrona y necesita revision), el saldo se cobra en persona: el staff ya
 * vio la transferencia llegar y confirma en el momento. Solo procede si el
 * modo global de SINPE es MANUAL — en modo ONVO, el cobro pasa por
 * crearIntencionSaldoOnvo (pago-sinpe-onvo.service.ts).
 */
export async function marcarSaldoPagadoManual(
  prisma: PrismaClient,
  codigoPublico: string,
): Promise<ResultadoCobroSaldo> {
  const modo = await obtenerModoSinpe(prisma);
  if (modo !== "MANUAL") return { ok: false, motivo: "MODO_INCORRECTO" };

  return prisma.$transaction(async (tx) => {
    const reserva = await bloquearYLeerReservaPorCodigo(tx, codigoPublico);
    if (!reserva) return { ok: false, motivo: "NO_ENCONTRADA" };
    if (reserva.estado === "PAGADA") return { ok: true };
    if (reserva.estado !== "CONFIRMADA") return { ok: false, motivo: "ESTADO_INVALIDO" };

    const pagadoEn = new Date();
    await tx.payment.create({
      data: {
        reservationId: reserva.id,
        tipo: "SALDO",
        monto: Number(reserva.montoSaldo),
        moneda: reserva.moneda,
        metodo: "SINPE_MANUAL",
        estado: "PAGADO",
        pagadoEn,
      },
    });
    await tx.reservation.update({ where: { id: reserva.id }, data: { estado: "PAGADA" } });
    return { ok: true };
  });
}
