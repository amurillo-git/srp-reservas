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
import { calcularPrecio } from "../motor-disponibilidad/motor-disponibilidad.js";

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
    await tx.reservation.update({ where: { id: reserva.id }, data: { estado: "PAGADA", montoSaldo: 0 } });
    return { ok: true };
  });
}

export type MotivoRechazoAjusteAsistentes = "NO_ENCONTRADA" | "ESTADO_INVALIDO" | "CANTIDAD_INVALIDA";

export type ResultadoAjusteAsistentes =
  | { readonly ok: true }
  | { readonly ok: false; readonly motivo: MotivoRechazoAjusteAsistentes };

/**
 * Ajusta la cantidad de personas que realmente llegaron al parque (28),
 * cuando es MENOR a la reservada — si llegan mas sin avisar, se resuelve
 * manualmente fuera del sistema (solo se trabaja bajo reserva). Recalcula el
 * total segun las tarifas del servicio para la nueva cantidad; el deposito
 * ya pagado NO se toca, y el saldo pendiente se recalcula (nunca negativo:
 * no hay creditos a favor si el nuevo total queda por debajo de lo pagado).
 *
 * No modifica HeatAllocation: es el mismo dia del evento, liberar cupo no
 * tiene ningun efecto util (nadie mas va a ocuparlo a esa hora).
 */
export async function ajustarAsistentesReales(
  prisma: PrismaClient,
  codigoPublico: string,
  cantidadReal: number,
): Promise<ResultadoAjusteAsistentes> {
  if (!Number.isInteger(cantidadReal) || cantidadReal <= 0) {
    return { ok: false, motivo: "CANTIDAD_INVALIDA" };
  }

  return prisma.$transaction(async (tx) => {
    const reserva = await bloquearYLeerReservaPorCodigo(tx, codigoPublico);
    if (!reserva) return { ok: false, motivo: "NO_ENCONTRADA" };
    if (reserva.estado !== "CONFIRMADA") return { ok: false, motivo: "ESTADO_INVALIDO" };
    if (cantidadReal > reserva.cantidadPersonas) return { ok: false, motivo: "CANTIDAD_INVALIDA" };
    if (cantidadReal === reserva.cantidadPersonas) return { ok: true };

    const servicio = await tx.service.findUnique({ where: { id: reserva.servicioId } });
    if (!servicio) return { ok: false, motivo: "NO_ENCONTRADA" };

    const precio = calcularPrecio(
      {
        servicioId: servicio.id,
        moneda: servicio.moneda,
        precioPorPersonaGrupoPequeno: Number(servicio.precioPorPersonaGrupoPequeno),
        precioPorPersonaGrupoGrande: Number(servicio.precioPorPersonaGrupoGrande),
        porcentajeDeposito: servicio.porcentajeDeposito,
      },
      cantidadReal,
    );

    await tx.reservation.update({
      where: { id: reserva.id },
      data: {
        cantidadPersonas: cantidadReal,
        montoTotal: precio.montoTotal,
        montoSaldo: Math.max(0, precio.montoTotal - Number(reserva.montoDeposito)),
      },
    });

    return { ok: true };
  });
}
