// ============================================================================
// Servicio de pago con tarjeta via ONVO (6.8, checkout hospedado).
//
// crearSesionPago abre una sesion de Checkout de ONVO por el monto de
// deposito de una reserva TEMPORAL y guarda el id de esa sesion en la
// reserva. NO confirma la reserva: el comprador paga en la pagina hospedada
// de ONVO, y es procesarWebhookOnvo quien confirma cuando ONVO notifica el
// pago exitoso. Si el comprador tarda mas de los 30 minutos de retencion
// (6.7.1), el worker de expiracion vence la reserva igual que si nunca
// hubiera iniciado el pago con tarjeta; un webhook que llegue despues no la
// resucita (ver procesarWebhookOnvo).
//
// Mismo patron de lock que pagos.service.ts (SINPE) y expiracion.service.ts:
// SELECT ... FOR UPDATE antes de leer/mutar el estado de la reserva.
// ============================================================================

import { Prisma, PrismaClient } from "@prisma/client";

const ONVO_CHECKOUT_URL = "https://api.onvopay.com/v1/checkout/sessions/one-time-link";

async function bloquearYLeerReservaPorCodigo(tx: Prisma.TransactionClient, codigoPublico: string) {
  const previa = await tx.reservation.findUnique({ where: { codigoPublico } });
  if (!previa) return null;
  await tx.$queryRaw`SELECT id FROM "reservations" WHERE id = ${previa.id} FOR UPDATE`;
  return tx.reservation.findUnique({ where: { id: previa.id } });
}

async function bloquearYLeerReservaPorSesion(tx: Prisma.TransactionClient, sesionId: string) {
  const previa = await tx.reservation.findUnique({ where: { pagoTarjetaSesionId: sesionId } });
  if (!previa) return null;
  await tx.$queryRaw`SELECT id FROM "reservations" WHERE id = ${previa.id} FOR UPDATE`;
  return tx.reservation.findUnique({ where: { id: previa.id } });
}

export type MotivoRechazoSesionPago =
  | "NO_ENCONTRADA"
  | "ESTADO_INVALIDO"
  | "VENCIDA"
  | "ERROR_PROVEEDOR"
  | "DESHABILITADO";

export type ResultadoCrearSesionPago =
  | { readonly ok: true; readonly checkoutUrl: string }
  | { readonly ok: false; readonly motivo: MotivoRechazoSesionPago };

export interface DependenciasCrearSesionPago {
  /** Inyectable para pruebas: evita llamar la API real de ONVO. */
  readonly fetchImpl?: typeof fetch;
}

/**
 * Crea una sesion de Checkout de ONVO por el monto de deposito de una
 * reserva TEMPORAL (6.8) y guarda su id en la reserva para que
 * procesarWebhookOnvo pueda encontrarla despues.
 */
export async function crearSesionPago(
  prisma: PrismaClient,
  codigoPublico: string,
  { fetchImpl = fetch }: DependenciasCrearSesionPago = {},
): Promise<ResultadoCrearSesionPago> {
  const reserva = await prisma.$transaction((tx) => bloquearYLeerReservaPorCodigo(tx, codigoPublico));
  if (!reserva) return { ok: false, motivo: "NO_ENCONTRADA" };
  if (reserva.estado !== "TEMPORAL") return { ok: false, motivo: "ESTADO_INVALIDO" };
  if (reserva.expiraEn !== null && reserva.expiraEn <= new Date()) {
    return { ok: false, motivo: "VENCIDA" };
  }
  // 6.8: revalida el flag aca (no solo en la capa HTTP) para que este
  // servicio nunca abra una sesion de pago que no pueda confirmarse.
  const servicio = await prisma.service.findUnique({ where: { id: reserva.servicioId } });
  if (!servicio?.pagoTarjetaHabilitado) {
    return { ok: false, motivo: "DESHABILITADO" };
  }

  const urlRetorno = `${process.env.WEB_APP_URL ?? "http://localhost:3001"}/mi-reserva?codigo=${reserva.codigoPublico}`;

  let respuesta: Response;
  try {
    respuesta = await fetchImpl(ONVO_CHECKOUT_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.ONVO_SECRET_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        lineItems: [
          {
            quantity: 1,
            // ONVO recibe montos en la unidad menor de la moneda (6.8): x100.
            unitAmount: Math.round(Number(reserva.montoDeposito) * 100),
            currency: reserva.moneda,
            description: `Deposito reserva ${reserva.codigoPublico} - Sarapiqui Race Park`,
          },
        ],
        customerEmail: reserva.clienteEmail ?? undefined,
        redirectUrl: urlRetorno,
        cancelUrl: urlRetorno,
        metadata: { codigoPublico: reserva.codigoPublico },
      }),
    });
  } catch {
    return { ok: false, motivo: "ERROR_PROVEEDOR" };
  }

  if (!respuesta.ok) {
    return { ok: false, motivo: "ERROR_PROVEEDOR" };
  }

  const sesion = (await respuesta.json()) as { id: string; url: string };

  await prisma.reservation.update({
    where: { id: reserva.id },
    data: { pagoTarjetaSesionId: sesion.id },
  });

  return { ok: true, checkoutUrl: sesion.url };
}

export type MotivoRechazoWebhookOnvo = "FIRMA_INVALIDA" | "NO_ENCONTRADA" | "ESTADO_INVALIDO";

export type ResultadoWebhookOnvo =
  | { readonly ok: true }
  | { readonly ok: false; readonly motivo: MotivoRechazoWebhookOnvo };

export interface EventoWebhookOnvo {
  readonly type: string;
  readonly data: { readonly id: string; readonly paymentStatus?: string };
}

async function confirmarPorSesionCheckout(prisma: PrismaClient, sesionId: string): Promise<ResultadoWebhookOnvo> {
  return prisma.$transaction(async (tx) => {
    const reserva = await bloquearYLeerReservaPorSesion(tx, sesionId);
    if (!reserva) return { ok: false, motivo: "NO_ENCONTRADA" };
    if (reserva.estado === "CONFIRMADA") return { ok: true };
    if (reserva.estado !== "TEMPORAL") return { ok: false, motivo: "ESTADO_INVALIDO" };

    const confirmadaEn = new Date();
    await tx.reservation.update({
      where: { id: reserva.id },
      data: { estado: "CONFIRMADA", confirmadaEn },
    });
    // 25: registra el cobro en el ledger de Payment, con el id de la sesion
    // de ONVO para poder correlacionarlo despues.
    await tx.payment.create({
      data: {
        reservationId: reserva.id,
        tipo: "DEPOSITO",
        monto: Number(reserva.montoDeposito),
        moneda: reserva.moneda,
        metodo: "TARJETA_ONVO",
        estado: "PAGADO",
        onvoPaymentIntentId: sesionId,
        pagadoEn: confirmadaEn,
      },
    });
    return { ok: true };
  });
}

/**
 * Confirma un Payment (deposito, SINPE via ONVO) por el id de su
 * PaymentIntent (25). A diferencia del checkout de tarjeta, el Payment ya
 * existe en estado PENDIENTE (creado por crearIntencionSinpeOnvo); este
 * webhook solo lo marca PAGADO y, si la reserva sigue TEMPORAL, la confirma.
 * Idempotente: un Payment ya PAGADO no se reprocesa.
 */
async function confirmarPorIntencionPago(prisma: PrismaClient, intencionId: string): Promise<ResultadoWebhookOnvo> {
  return prisma.$transaction(async (tx) => {
    const pago = await tx.payment.findUnique({ where: { onvoPaymentIntentId: intencionId } });
    if (!pago) return { ok: false, motivo: "NO_ENCONTRADA" };
    if (pago.estado === "PAGADO") return { ok: true };

    const previa = await tx.reservation.findUnique({ where: { id: pago.reservationId } });
    if (!previa) return { ok: false, motivo: "NO_ENCONTRADA" };
    await tx.$queryRaw`SELECT id FROM "reservations" WHERE id = ${previa.id} FOR UPDATE`;
    const reserva = await tx.reservation.findUnique({ where: { id: previa.id } });
    if (!reserva) return { ok: false, motivo: "NO_ENCONTRADA" };

    const pagadoEn = new Date();
    await tx.payment.update({ where: { id: pago.id }, data: { estado: "PAGADO", pagadoEn } });

    if (pago.tipo === "DEPOSITO" && reserva.estado === "TEMPORAL") {
      await tx.reservation.update({
        where: { id: reserva.id },
        data: { estado: "CONFIRMADA", confirmadaEn: pagadoEn },
      });
    }
    // tipo === "SALDO" se maneja en la sub-entrega del flujo de cobro de saldo.

    return { ok: true };
  });
}

/** Marca RECHAZADO un Payment cuya intencion de ONVO fallo (25). No toca la
 * reserva: el cliente puede seguir intentando dentro de su plazo de
 * retencion (mismo criterio que un comprobante SINPE manual rechazado no
 * cancela la reserva por si solo). */
async function marcarIntencionRechazada(prisma: PrismaClient, intencionId: string): Promise<void> {
  const pago = await prisma.payment.findUnique({ where: { onvoPaymentIntentId: intencionId } });
  if (pago && pago.estado === "PENDIENTE") {
    await prisma.payment.update({ where: { id: pago.id }, data: { estado: "RECHAZADO" } });
  }
}

/**
 * Procesa un webhook de ONVO (6.8, 25). Actua sobre:
 * - `checkout-session.succeeded` con `data.paymentStatus === "paid"` (pago
 *   con tarjeta).
 * - `payment-intent.succeeded` (SINPE automatico via ONVO).
 * - `payment-intent.failed` (marca el Payment como RECHAZADO).
 * Cualquier otro evento (incluido `payment-intent.deferred`, que solo indica
 * que ONVO sigue esperando la transferencia) se acepta sin efecto, para que
 * ONVO no lo reintente indefinidamente. Idempotente: una reserva/Payment ya
 * confirmados no se reprocesan, y una reserva ya terminal
 * (EXPIRADA/CANCELADA/RECHAZADA) nunca se resucita.
 */
export async function procesarWebhookOnvo(
  prisma: PrismaClient,
  headerSecretRecibido: string | undefined,
  evento: EventoWebhookOnvo,
): Promise<ResultadoWebhookOnvo> {
  const secretoEsperado = process.env.ONVO_WEBHOOK_SECRET;
  if (!secretoEsperado || headerSecretRecibido !== secretoEsperado) {
    return { ok: false, motivo: "FIRMA_INVALIDA" };
  }

  if (evento.type === "checkout-session.succeeded" && evento.data.paymentStatus === "paid") {
    return confirmarPorSesionCheckout(prisma, evento.data.id);
  }

  if (evento.type === "payment-intent.succeeded") {
    return confirmarPorIntencionPago(prisma, evento.data.id);
  }

  if (evento.type === "payment-intent.failed") {
    await marcarIntencionRechazada(prisma, evento.data.id);
    return { ok: true };
  }

  return { ok: true };
}

export type MotivoRechazoActualizarPagoTarjeta = "WEBHOOK_NO_CONFIGURADO" | "SERVICIO_NO_ENCONTRADO";

export type ResultadoActualizarPagoTarjeta =
  | { readonly ok: true }
  | { readonly ok: false; readonly motivo: MotivoRechazoActualizarPagoTarjeta };

/**
 * Activa/desactiva "pagar con tarjeta" para un servicio (6.8, panel admin).
 * Salvavidas: activarlo (no desactivarlo) exige `ONVO_WEBHOOK_SECRET`
 * configurado, para que nunca quede un pago sin poder confirmarse
 * automaticamente (ver procesarWebhookOnvo, que rechaza todo webhook sin
 * ese secreto).
 */
export async function establecerPagoTarjetaHabilitado(
  prisma: PrismaClient,
  servicioId: string,
  habilitado: boolean,
): Promise<ResultadoActualizarPagoTarjeta> {
  if (habilitado && !process.env.ONVO_WEBHOOK_SECRET) {
    return { ok: false, motivo: "WEBHOOK_NO_CONFIGURADO" };
  }
  const servicio = await prisma.service.findUnique({ where: { id: servicioId } });
  if (!servicio) {
    return { ok: false, motivo: "SERVICIO_NO_ENCONTRADO" };
  }
  await prisma.service.update({ where: { id: servicioId }, data: { pagoTarjetaHabilitado: habilitado } });
  return { ok: true };
}
