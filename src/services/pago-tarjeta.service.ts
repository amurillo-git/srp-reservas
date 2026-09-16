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

export type MotivoRechazoSesionPago = "NO_ENCONTRADA" | "ESTADO_INVALIDO" | "VENCIDA" | "ERROR_PROVEEDOR";

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

/**
 * Procesa un webhook de ONVO (6.8). Solo actua sobre
 * `checkout-session.succeeded` con `data.paymentStatus === "paid"`;
 * cualquier otro evento se acepta sin efecto (para que ONVO no lo reintente
 * indefinidamente). Idempotente: una reserva ya CONFIRMADA no se reprocesa
 * ni falla, y una reserva ya terminal (EXPIRADA/CANCELADA/RECHAZADA) nunca
 * se resucita.
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

  if (evento.type !== "checkout-session.succeeded" || evento.data.paymentStatus !== "paid") {
    return { ok: true };
  }

  return prisma.$transaction(async (tx) => {
    const reserva = await bloquearYLeerReservaPorSesion(tx, evento.data.id);
    if (!reserva) return { ok: false, motivo: "NO_ENCONTRADA" };
    if (reserva.estado === "CONFIRMADA") return { ok: true };
    if (reserva.estado !== "TEMPORAL") return { ok: false, motivo: "ESTADO_INVALIDO" };

    await tx.reservation.update({
      where: { id: reserva.id },
      data: { estado: "CONFIRMADA", confirmadaEn: new Date() },
    });
    return { ok: true };
  });
}
