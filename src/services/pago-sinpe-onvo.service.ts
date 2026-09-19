// ============================================================================
// Pago SINPE Movil automatico via ONVO (25, modo ONVO de configuracion-pago).
//
// A diferencia del checkout de tarjeta (pago-tarjeta.service.ts, Checkout
// Sessions), SINPE via ONVO usa la API de Payment Intents en 3 pasos:
//   1. POST /v1/payment-intents           -> crea la intencion (monto/moneda)
//   2. POST /v1/payment-methods           -> crea el metodo tipo mobile_number
//      (ONVO exige cedula + tipo de identificacion del cliente, no solo el
//      telefono, para poder asociar la transferencia SINPE que llegue)
//   3. POST /v1/payment-intents/{id}/confirm -> asocia el metodo a la intencion
//
// NO confirma la reserva: el cliente todavia tiene que hacer la transferencia
// SINPE real al numero de ONVO; es procesarWebhookOnvo (pago-tarjeta.service.ts)
// quien confirma cuando llega el webhook payment-intent.succeeded.
//
// Mismo patron de lock (SELECT ... FOR UPDATE) que pagos.service.ts y
// pago-tarjeta.service.ts: la duplicacion del helper es deliberada, ver sus
// comentarios.
// ============================================================================

import { Prisma, PrismaClient } from "@prisma/client";
import { obtenerModoSinpe } from "./configuracion-pago.service.js";

const ONVO_PAYMENT_INTENTS_URL = "https://api.onvopay.com/v1/payment-intents";
const ONVO_PAYMENT_METHODS_URL = "https://api.onvopay.com/v1/payment-methods";

/** Numero de SINPE Movil de ONVO al que el cliente debe transferir (dado por
 * ONVO al habilitar SINPE en la cuenta del comercio). Configurable por si
 * ONVO lo cambia, con el valor que confirmaron por soporte como default. */
const NUMERO_SINPE_ONVO = process.env.ONVO_SINPE_NUMBER ?? "+50670196686";

async function bloquearYLeerReservaPorCodigo(tx: Prisma.TransactionClient, codigoPublico: string) {
  const previa = await tx.reservation.findUnique({ where: { codigoPublico } });
  if (!previa) return null;
  await tx.$queryRaw`SELECT id FROM "reservations" WHERE id = ${previa.id} FOR UPDATE`;
  return tx.reservation.findUnique({ where: { id: previa.id } });
}

export interface DatosClienteSinpeOnvo {
  readonly telefono: string;
  readonly cedula: string;
  /** Tipo de identificacion de ONVO; 0 = cedula fisica costarricense (unico
   * valor documentado, usado como default). */
  readonly tipoIdentificacion?: number;
}

export type MotivoRechazoIntencionSinpe =
  | "NO_ENCONTRADA"
  | "ESTADO_INVALIDO"
  | "VENCIDA"
  | "MODO_INCORRECTO"
  | "ERROR_PROVEEDOR";

export type ResultadoCrearIntencionSinpe =
  | { readonly ok: true; readonly numeroSinpe: string; readonly monto: number; readonly moneda: string }
  | { readonly ok: false; readonly motivo: MotivoRechazoIntencionSinpe };

export interface DependenciasSinpeOnvo {
  /** Inyectable para pruebas: evita llamar la API real de ONVO. */
  readonly fetchImpl?: typeof fetch;
}

/**
 * Crea (y confirma) una intencion de pago SINPE en ONVO por el monto de
 * deposito de una reserva TEMPORAL (25). Solo procede si la configuracion
 * global esta en modo ONVO (ver configuracion-pago.service.ts) — en modo
 * MANUAL, el cliente sigue el flujo de reportar comprobante (pagos.service.ts).
 */
export async function crearIntencionSinpeOnvo(
  prisma: PrismaClient,
  codigoPublico: string,
  datosCliente: DatosClienteSinpeOnvo,
  { fetchImpl = fetch }: DependenciasSinpeOnvo = {},
): Promise<ResultadoCrearIntencionSinpe> {
  const modo = await obtenerModoSinpe(prisma);
  if (modo !== "ONVO") return { ok: false, motivo: "MODO_INCORRECTO" };

  const reserva = await prisma.$transaction((tx) => bloquearYLeerReservaPorCodigo(tx, codigoPublico));
  if (!reserva) return { ok: false, motivo: "NO_ENCONTRADA" };
  if (reserva.estado !== "TEMPORAL") return { ok: false, motivo: "ESTADO_INVALIDO" };
  if (reserva.expiraEn !== null && reserva.expiraEn <= new Date()) {
    return { ok: false, motivo: "VENCIDA" };
  }

  const headers = {
    Authorization: `Bearer ${process.env.ONVO_SECRET_KEY}`,
    "Content-Type": "application/json",
  };

  let intentoRespuesta: Response;
  try {
    intentoRespuesta = await fetchImpl(ONVO_PAYMENT_INTENTS_URL, {
      method: "POST",
      headers,
      body: JSON.stringify({
        // ONVO recibe montos en la unidad menor de la moneda (igual que el
        // checkout de tarjeta): x100.
        amount: Math.round(Number(reserva.montoDeposito) * 100),
        currency: reserva.moneda,
        description: `Deposito reserva ${reserva.codigoPublico} - Sarapiqui Race Park`,
        metadata: { codigoPublico: reserva.codigoPublico, tipoPago: "DEPOSITO" },
      }),
    });
  } catch {
    return { ok: false, motivo: "ERROR_PROVEEDOR" };
  }
  if (!intentoRespuesta.ok) return { ok: false, motivo: "ERROR_PROVEEDOR" };
  const intento = (await intentoRespuesta.json()) as { id: string };

  let metodoRespuesta: Response;
  try {
    metodoRespuesta = await fetchImpl(ONVO_PAYMENT_METHODS_URL, {
      method: "POST",
      headers,
      body: JSON.stringify({
        type: "mobile_number",
        mobileNumber: {
          identification: datosCliente.cedula,
          identificationType: datosCliente.tipoIdentificacion ?? 0,
          number: datosCliente.telefono,
        },
      }),
    });
  } catch {
    return { ok: false, motivo: "ERROR_PROVEEDOR" };
  }
  if (!metodoRespuesta.ok) return { ok: false, motivo: "ERROR_PROVEEDOR" };
  const metodo = (await metodoRespuesta.json()) as { id: string };

  let confirmarRespuesta: Response;
  try {
    confirmarRespuesta = await fetchImpl(`${ONVO_PAYMENT_INTENTS_URL}/${intento.id}/confirm`, {
      method: "POST",
      headers,
      body: JSON.stringify({ paymentMethodId: metodo.id }),
    });
  } catch {
    return { ok: false, motivo: "ERROR_PROVEEDOR" };
  }
  if (!confirmarRespuesta.ok) return { ok: false, motivo: "ERROR_PROVEEDOR" };

  await prisma.payment.create({
    data: {
      reservationId: reserva.id,
      tipo: "DEPOSITO",
      monto: Number(reserva.montoDeposito),
      moneda: reserva.moneda,
      metodo: "SINPE_ONVO",
      estado: "PENDIENTE",
      onvoPaymentIntentId: intento.id,
    },
  });

  return { ok: true, numeroSinpe: NUMERO_SINPE_ONVO, monto: Number(reserva.montoDeposito), moneda: reserva.moneda };
}
