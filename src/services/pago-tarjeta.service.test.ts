import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { crearSesionPago, establecerPagoTarjetaHabilitado, procesarWebhookOnvo } from "./pago-tarjeta.service.js";
import { FakePrisma, type FilaReserva } from "./testing/fake-prisma.js";

function comoPrisma(fake: FakePrisma): PrismaClient {
  return fake as unknown as PrismaClient;
}

function crearReservaTemporal(fake: FakePrisma, datos: Partial<FilaReserva> = {}): FilaReserva {
  const reserva: FilaReserva = {
    id: "res-1",
    codigoPublico: "SRP-0001",
    servicioId: "svc-1",
    fecha: new Date("2026-12-25T00:00:00.000Z"),
    cantidadPersonas: 2,
    estado: "TEMPORAL",
    moneda: "CRC",
    montoTotal: 16000,
    montoDeposito: 8000,
    montoSaldo: 8000,
    claveIdempotencia: "idem-1",
    clienteNombre: "Ana Mora",
    clienteTelefono: "88888888",
    clienteEmail: "ana@example.com",
    expiraEn: new Date(Date.now() + 30 * 60 * 1000),
    ...datos,
  };
  fake.reservas.push(reserva);
  return reserva;
}

describe("crearSesionPago", () => {
  const ORIGINAL_ENV = { ...process.env };

  beforeEach(() => {
    process.env.ONVO_SECRET_KEY = "onvo_test_secret_key_fake";
    process.env.WEB_APP_URL = "https://reservas.sarapiquiracepark.com";
  });

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
    vi.restoreAllMocks();
  });

  it("crea una sesion de Checkout de ONVO por el monto del deposito y la guarda en la reserva", async () => {
    const fake = new FakePrisma();
    fake.crearServicio({ id: "svc-1", pagoTarjetaHabilitado: true });
    crearReservaTemporal(fake);

    const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
      expect(url).toBe("https://api.onvopay.com/v1/checkout/sessions/one-time-link");
      const headers = init.headers as Record<string, string>;
      expect(headers.Authorization).toBe("Bearer onvo_test_secret_key_fake");
      const body = JSON.parse(init.body as string);
      expect(body.lineItems).toEqual([
        { quantity: 1, unitAmount: 800000, currency: "CRC", description: expect.stringContaining("SRP-0001") },
      ]);
      expect(body.metadata).toEqual({ codigoPublico: "SRP-0001" });
      return new Response(JSON.stringify({ id: "clcs0001", url: "https://checkout.onvopay.com/pay/clcs0001" }), {
        status: 201,
      });
    });

    const resultado = await crearSesionPago(comoPrisma(fake), "SRP-0001", { fetchImpl });

    expect(resultado).toEqual({ ok: true, checkoutUrl: "https://checkout.onvopay.com/pay/clcs0001" });
    expect(fake.reservas[0]!.pagoTarjetaSesionId).toBe("clcs0001");
    expect(fake.reservas[0]!.estado).toBe("TEMPORAL"); // 6.8: el webhook es quien confirma, no la creacion de la sesion.
  });

  it("devuelve NO_ENCONTRADA si el codigo publico no existe", async () => {
    const fake = new FakePrisma();
    const resultado = await crearSesionPago(comoPrisma(fake), "SRP-9999", { fetchImpl: vi.fn() });
    expect(resultado).toEqual({ ok: false, motivo: "NO_ENCONTRADA" });
  });

  it("devuelve ESTADO_INVALIDO si la reserva no esta TEMPORAL", async () => {
    const fake = new FakePrisma();
    fake.crearServicio({ id: "svc-1", pagoTarjetaHabilitado: true });
    crearReservaTemporal(fake, { estado: "CONFIRMADA" });
    const resultado = await crearSesionPago(comoPrisma(fake), "SRP-0001", { fetchImpl: vi.fn() });
    expect(resultado).toEqual({ ok: false, motivo: "ESTADO_INVALIDO" });
  });

  it("devuelve VENCIDA si la reserva TEMPORAL ya supero su plazo de retencion", async () => {
    const fake = new FakePrisma();
    fake.crearServicio({ id: "svc-1", pagoTarjetaHabilitado: true });
    crearReservaTemporal(fake, { expiraEn: new Date(Date.now() - 1000) });
    const resultado = await crearSesionPago(comoPrisma(fake), "SRP-0001", { fetchImpl: vi.fn() });
    expect(resultado).toEqual({ ok: false, motivo: "VENCIDA" });
  });

  it("devuelve ERROR_PROVEEDOR si ONVO responde con error", async () => {
    const fake = new FakePrisma();
    fake.crearServicio({ id: "svc-1", pagoTarjetaHabilitado: true });
    crearReservaTemporal(fake);
    const fetchImpl = vi.fn(async () => new Response("{}", { status: 500 }));
    const resultado = await crearSesionPago(comoPrisma(fake), "SRP-0001", { fetchImpl });
    expect(resultado).toEqual({ ok: false, motivo: "ERROR_PROVEEDOR" });
    expect(fake.reservas[0]!.pagoTarjetaSesionId).toBeUndefined();
  });

  it("devuelve ERROR_PROVEEDOR si la solicitud a ONVO falla (red)", async () => {
    const fake = new FakePrisma();
    fake.crearServicio({ id: "svc-1", pagoTarjetaHabilitado: true });
    crearReservaTemporal(fake);
    const fetchImpl = vi.fn(async () => {
      throw new Error("network down");
    });
    const resultado = await crearSesionPago(comoPrisma(fake), "SRP-0001", { fetchImpl });
    expect(resultado).toEqual({ ok: false, motivo: "ERROR_PROVEEDOR" });
  });

  it("devuelve DESHABILITADO si el servicio tiene apagado el pago con tarjeta", async () => {
    const fake = new FakePrisma();
    fake.crearServicio({ id: "svc-1", pagoTarjetaHabilitado: false });
    crearReservaTemporal(fake);
    const resultado = await crearSesionPago(comoPrisma(fake), "SRP-0001", { fetchImpl: vi.fn() });
    expect(resultado).toEqual({ ok: false, motivo: "DESHABILITADO" });
  });
});

describe("establecerPagoTarjetaHabilitado", () => {
  const ORIGINAL_ENV = { ...process.env };

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  it("activa el pago con tarjeta si ONVO_WEBHOOK_SECRET esta configurado", async () => {
    process.env.ONVO_WEBHOOK_SECRET = "webhook_secret_fake";
    const fake = new FakePrisma();
    fake.crearServicio({ id: "svc-1", pagoTarjetaHabilitado: false });

    const resultado = await establecerPagoTarjetaHabilitado(comoPrisma(fake), "svc-1", true);

    expect(resultado).toEqual({ ok: true });
    expect(fake.servicios[0]!.pagoTarjetaHabilitado).toBe(true);
  });

  it("rechaza activarlo si ONVO_WEBHOOK_SECRET no esta configurado", async () => {
    delete process.env.ONVO_WEBHOOK_SECRET;
    const fake = new FakePrisma();
    fake.crearServicio({ id: "svc-1", pagoTarjetaHabilitado: false });

    const resultado = await establecerPagoTarjetaHabilitado(comoPrisma(fake), "svc-1", true);

    expect(resultado).toEqual({ ok: false, motivo: "WEBHOOK_NO_CONFIGURADO" });
    expect(fake.servicios[0]!.pagoTarjetaHabilitado).toBe(false);
  });

  it("permite desactivarlo sin importar si el webhook esta configurado", async () => {
    delete process.env.ONVO_WEBHOOK_SECRET;
    const fake = new FakePrisma();
    fake.crearServicio({ id: "svc-1", pagoTarjetaHabilitado: true });

    const resultado = await establecerPagoTarjetaHabilitado(comoPrisma(fake), "svc-1", false);

    expect(resultado).toEqual({ ok: true });
    expect(fake.servicios[0]!.pagoTarjetaHabilitado).toBe(false);
  });

  it("devuelve SERVICIO_NO_ENCONTRADO si el id no existe", async () => {
    process.env.ONVO_WEBHOOK_SECRET = "webhook_secret_fake";
    const fake = new FakePrisma();

    const resultado = await establecerPagoTarjetaHabilitado(comoPrisma(fake), "no-existe", true);

    expect(resultado).toEqual({ ok: false, motivo: "SERVICIO_NO_ENCONTRADO" });
  });
});

describe("procesarWebhookOnvo", () => {
  const ORIGINAL_ENV = { ...process.env };

  beforeEach(() => {
    process.env.ONVO_WEBHOOK_SECRET = "webhook_secret_fake";
  });

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  it("confirma la reserva TEMPORAL cuando checkout-session.succeeded llega con paymentStatus paid", async () => {
    const fake = new FakePrisma();
    crearReservaTemporal(fake, { pagoTarjetaSesionId: "clcs0001" });

    const resultado = await procesarWebhookOnvo(comoPrisma(fake), "webhook_secret_fake", {
      type: "checkout-session.succeeded",
      data: { id: "clcs0001", paymentStatus: "paid" },
    });

    expect(resultado).toEqual({ ok: true });
    expect(fake.reservas[0]!.estado).toBe("CONFIRMADA");
    expect(fake.reservas[0]!.confirmadaEn).toBeInstanceOf(Date);
  });

  it("rechaza el webhook si el header X-Webhook-Secret no coincide", async () => {
    const fake = new FakePrisma();
    crearReservaTemporal(fake, { pagoTarjetaSesionId: "clcs0001" });

    const resultado = await procesarWebhookOnvo(comoPrisma(fake), "secreto-incorrecto", {
      type: "checkout-session.succeeded",
      data: { id: "clcs0001", paymentStatus: "paid" },
    });

    expect(resultado).toEqual({ ok: false, motivo: "FIRMA_INVALIDA" });
    expect(fake.reservas[0]!.estado).toBe("TEMPORAL");
  });

  it("ignora (ok:true, sin efecto) eventos que no sean checkout-session.succeeded con paymentStatus paid", async () => {
    const fake = new FakePrisma();
    crearReservaTemporal(fake, { pagoTarjetaSesionId: "clcs0001" });

    const resultado = await procesarWebhookOnvo(comoPrisma(fake), "webhook_secret_fake", {
      type: "payment-intent.failed",
      data: { id: "clcs0001" },
    });

    expect(resultado).toEqual({ ok: true });
    expect(fake.reservas[0]!.estado).toBe("TEMPORAL");
  });

  it("es idempotente: una reserva ya CONFIRMADA no falla ni se reprocesa", async () => {
    const fake = new FakePrisma();
    crearReservaTemporal(fake, { pagoTarjetaSesionId: "clcs0001", estado: "CONFIRMADA", confirmadaEn: new Date(0) });

    const resultado = await procesarWebhookOnvo(comoPrisma(fake), "webhook_secret_fake", {
      type: "checkout-session.succeeded",
      data: { id: "clcs0001", paymentStatus: "paid" },
    });

    expect(resultado).toEqual({ ok: true });
    expect(fake.reservas[0]!.confirmadaEn).toEqual(new Date(0));
  });

  it("devuelve ESTADO_INVALIDO sin resucitar una reserva ya EXPIRADA/CANCELADA/RECHAZADA", async () => {
    const fake = new FakePrisma();
    crearReservaTemporal(fake, { pagoTarjetaSesionId: "clcs0001", estado: "EXPIRADA" });

    const resultado = await procesarWebhookOnvo(comoPrisma(fake), "webhook_secret_fake", {
      type: "checkout-session.succeeded",
      data: { id: "clcs0001", paymentStatus: "paid" },
    });

    expect(resultado).toEqual({ ok: false, motivo: "ESTADO_INVALIDO" });
    expect(fake.reservas[0]!.estado).toBe("EXPIRADA");
  });

  it("devuelve NO_ENCONTRADA si ninguna reserva tiene esa sesion de pago", async () => {
    const fake = new FakePrisma();
    const resultado = await procesarWebhookOnvo(comoPrisma(fake), "webhook_secret_fake", {
      type: "checkout-session.succeeded",
      data: { id: "clcs-inexistente", paymentStatus: "paid" },
    });
    expect(resultado).toEqual({ ok: false, motivo: "NO_ENCONTRADA" });
  });
});
