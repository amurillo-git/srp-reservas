import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { crearIntencionSinpeOnvo } from "./pago-sinpe-onvo.service.js";
import { establecerModoSinpe } from "./configuracion-pago.service.js";
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

const DATOS_CLIENTE = { telefono: "+50688888888", cedula: "1-1111-1111" };

function fetchImplExitoso() {
  return vi.fn(async (url: string, init: RequestInit) => {
    if (url === "https://api.onvopay.com/v1/payment-intents") {
      return new Response(JSON.stringify({ id: "clpiment0001", status: "requires_payment_method" }), { status: 201 });
    }
    if (url === "https://api.onvopay.com/v1/payment-methods") {
      const body = JSON.parse(init.body as string);
      expect(body).toEqual({
        type: "mobile_number",
        mobileNumber: { identification: "1-1111-1111", identificationType: 0, number: "+50688888888" },
      });
      return new Response(JSON.stringify({ id: "clpm0001" }), { status: 201 });
    }
    if (url === "https://api.onvopay.com/v1/payment-intents/clpiment0001/confirm") {
      const body = JSON.parse(init.body as string);
      expect(body).toEqual({ paymentMethodId: "clpm0001" });
      return new Response(JSON.stringify({ id: "clpiment0001", status: "processing" }), { status: 200 });
    }
    throw new Error(`URL inesperada en la prueba: ${url}`);
  });
}

describe("crearIntencionSinpeOnvo", () => {
  const ORIGINAL_ENV = { ...process.env };

  beforeEach(() => {
    process.env.ONVO_SECRET_KEY = "onvo_test_secret_key_fake";
  });

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
    vi.restoreAllMocks();
  });

  it("25: crea intencion + metodo + confirma en ONVO y registra el Payment PENDIENTE", async () => {
    const fake = new FakePrisma();
    await establecerModoSinpe(comoPrisma(fake), "ONVO");
    crearReservaTemporal(fake);
    const fetchImpl = fetchImplExitoso();

    const resultado = await crearIntencionSinpeOnvo(comoPrisma(fake), "SRP-0001", DATOS_CLIENTE, { fetchImpl });

    expect(resultado).toEqual({ ok: true, numeroSinpe: "+50670196686", monto: 8000, moneda: "CRC" });
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(fake.payments).toHaveLength(1);
    expect(fake.payments[0]).toMatchObject({
      reservationId: "res-1", tipo: "DEPOSITO", monto: 8000, moneda: "CRC",
      metodo: "SINPE_ONVO", estado: "PENDIENTE", onvoPaymentIntentId: "clpiment0001",
    });
  });

  it("devuelve MODO_INCORRECTO si el modo global sigue en MANUAL", async () => {
    const fake = new FakePrisma();
    crearReservaTemporal(fake);
    const fetchImpl = vi.fn();

    const resultado = await crearIntencionSinpeOnvo(comoPrisma(fake), "SRP-0001", DATOS_CLIENTE, { fetchImpl });

    expect(resultado).toEqual({ ok: false, motivo: "MODO_INCORRECTO" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("devuelve NO_ENCONTRADA si el codigo publico no existe", async () => {
    const fake = new FakePrisma();
    await establecerModoSinpe(comoPrisma(fake), "ONVO");
    const resultado = await crearIntencionSinpeOnvo(comoPrisma(fake), "SRP-9999", DATOS_CLIENTE, { fetchImpl: vi.fn() });
    expect(resultado).toEqual({ ok: false, motivo: "NO_ENCONTRADA" });
  });

  it("devuelve ESTADO_INVALIDO si la reserva no esta TEMPORAL", async () => {
    const fake = new FakePrisma();
    await establecerModoSinpe(comoPrisma(fake), "ONVO");
    crearReservaTemporal(fake, { estado: "CONFIRMADA" });
    const resultado = await crearIntencionSinpeOnvo(comoPrisma(fake), "SRP-0001", DATOS_CLIENTE, { fetchImpl: vi.fn() });
    expect(resultado).toEqual({ ok: false, motivo: "ESTADO_INVALIDO" });
  });

  it("devuelve VENCIDA si el plazo de retencion ya paso", async () => {
    const fake = new FakePrisma();
    await establecerModoSinpe(comoPrisma(fake), "ONVO");
    crearReservaTemporal(fake, { expiraEn: new Date(Date.now() - 1000) });
    const resultado = await crearIntencionSinpeOnvo(comoPrisma(fake), "SRP-0001", DATOS_CLIENTE, { fetchImpl: vi.fn() });
    expect(resultado).toEqual({ ok: false, motivo: "VENCIDA" });
  });

  it("devuelve ERROR_PROVEEDOR si falla la creacion de la intencion", async () => {
    const fake = new FakePrisma();
    await establecerModoSinpe(comoPrisma(fake), "ONVO");
    crearReservaTemporal(fake);
    const fetchImpl = vi.fn(async () => new Response("{}", { status: 500 }));
    const resultado = await crearIntencionSinpeOnvo(comoPrisma(fake), "SRP-0001", DATOS_CLIENTE, { fetchImpl });
    expect(resultado).toEqual({ ok: false, motivo: "ERROR_PROVEEDOR" });
    expect(fake.payments).toHaveLength(0);
  });

  it("devuelve ERROR_PROVEEDOR si falla la creacion del metodo de pago", async () => {
    const fake = new FakePrisma();
    await establecerModoSinpe(comoPrisma(fake), "ONVO");
    crearReservaTemporal(fake);
    const fetchImpl = vi.fn(async (url: string) => {
      if (url === "https://api.onvopay.com/v1/payment-intents") {
        return new Response(JSON.stringify({ id: "clpiment0001" }), { status: 201 });
      }
      return new Response("{}", { status: 500 });
    });
    const resultado = await crearIntencionSinpeOnvo(comoPrisma(fake), "SRP-0001", DATOS_CLIENTE, { fetchImpl });
    expect(resultado).toEqual({ ok: false, motivo: "ERROR_PROVEEDOR" });
    expect(fake.payments).toHaveLength(0);
  });

  it("devuelve ERROR_PROVEEDOR si falla la confirmacion", async () => {
    const fake = new FakePrisma();
    await establecerModoSinpe(comoPrisma(fake), "ONVO");
    crearReservaTemporal(fake);
    const fetchImpl = vi.fn(async (url: string) => {
      if (url === "https://api.onvopay.com/v1/payment-intents") {
        return new Response(JSON.stringify({ id: "clpiment0001" }), { status: 201 });
      }
      if (url === "https://api.onvopay.com/v1/payment-methods") {
        return new Response(JSON.stringify({ id: "clpm0001" }), { status: 201 });
      }
      return new Response("{}", { status: 500 });
    });
    const resultado = await crearIntencionSinpeOnvo(comoPrisma(fake), "SRP-0001", DATOS_CLIENTE, { fetchImpl });
    expect(resultado).toEqual({ ok: false, motivo: "ERROR_PROVEEDOR" });
    expect(fake.payments).toHaveLength(0);
  });
});
