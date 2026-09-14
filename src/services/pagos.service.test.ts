import { describe, expect, it } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { aprobarSinpe, rechazarSinpe, reportarComprobanteSinpe } from "./pagos.service.js";
import { FakePrisma, type FilaReserva } from "./testing/fake-prisma.js";

function comoPrisma(fake: FakePrisma): PrismaClient {
  return fake as unknown as PrismaClient;
}

const SERVICIO_ID = "svc-1";
const FECHA_DATE = new Date("2026-09-13T00:00:00.000Z");

function crearReserva(fake: FakePrisma, datos: Partial<FilaReserva> & { codigoPublico: string; estado: string }): FilaReserva {
  const fila: FilaReserva = {
    id: `res-${datos.codigoPublico}`,
    servicioId: SERVICIO_ID,
    fecha: FECHA_DATE,
    cantidadPersonas: 5,
    moneda: "CRC",
    montoTotal: 20000,
    montoDeposito: 10000,
    montoSaldo: 10000,
    claveIdempotencia: `idem-${datos.codigoPublico}`,
    clienteNombre: "Ana",
    clienteTelefono: "8888-0000",
    expiraEn: null,
    ...datos,
  };
  fake.reservas.push(fila);
  return fila;
}

describe("reportarComprobanteSinpe", () => {
  it("11.3: una reserva TEMPORAL no vencida pasa a PENDIENTE_VALIDACION_SINPE y guarda el comprobante", async () => {
    const fake = new FakePrisma();
    crearReserva(fake, {
      codigoPublico: "SRP-1", estado: "TEMPORAL",
      expiraEn: new Date(Date.now() + 10 * 60 * 1000),
    });

    const resultado = await reportarComprobanteSinpe(comoPrisma(fake), "SRP-1", {
      nombrePagador: "Ana Perez", referencia: "REF-123",
    });

    expect(resultado).toEqual({ ok: true });
    expect(fake.reservas.find((r) => r.codigoPublico === "SRP-1")!.estado).toBe("PENDIENTE_VALIDACION_SINPE");
    expect(fake.comprobantesSinpe).toHaveLength(1);
    expect(fake.comprobantesSinpe[0]).toMatchObject({ nombrePagador: "Ana Perez", referencia: "REF-123" });
  });

  it("devuelve NO_ENCONTRADA si el codigo no existe", async () => {
    const fake = new FakePrisma();
    const resultado = await reportarComprobanteSinpe(comoPrisma(fake), "SRP-NOEXISTE", {});
    expect(resultado).toEqual({ ok: false, motivo: "NO_ENCONTRADA" });
  });

  it("devuelve ESTADO_INVALIDO si la reserva ya no esta TEMPORAL", async () => {
    const fake = new FakePrisma();
    crearReserva(fake, { codigoPublico: "SRP-2", estado: "CONFIRMADA" });

    const resultado = await reportarComprobanteSinpe(comoPrisma(fake), "SRP-2", {});

    expect(resultado).toEqual({ ok: false, motivo: "ESTADO_INVALIDO" });
    expect(fake.comprobantesSinpe).toHaveLength(0);
  });

  it("devuelve VENCIDA si el plazo de 30 minutos ya paso (6.9.2)", async () => {
    const fake = new FakePrisma();
    crearReserva(fake, {
      codigoPublico: "SRP-3", estado: "TEMPORAL",
      expiraEn: new Date(Date.now() - 60 * 1000),
    });

    const resultado = await reportarComprobanteSinpe(comoPrisma(fake), "SRP-3", {});

    expect(resultado).toEqual({ ok: false, motivo: "VENCIDA" });
    expect(fake.reservas.find((r) => r.codigoPublico === "SRP-3")!.estado).toBe("TEMPORAL");
  });
});

describe("aprobarSinpe", () => {
  it("6.9.6-7: confirma una reserva PENDIENTE_VALIDACION_SINPE", async () => {
    const fake = new FakePrisma();
    crearReserva(fake, { codigoPublico: "SRP-4", estado: "PENDIENTE_VALIDACION_SINPE" });

    const resultado = await aprobarSinpe(comoPrisma(fake), "SRP-4");

    expect(resultado).toEqual({ ok: true });
    const reserva = fake.reservas.find((r) => r.codigoPublico === "SRP-4")!;
    expect(reserva.estado).toBe("CONFIRMADA");
    expect(reserva.confirmadaEn).toBeInstanceOf(Date);
  });

  it("devuelve ESTADO_INVALIDO si no esta pendiente de validacion", async () => {
    const fake = new FakePrisma();
    crearReserva(fake, { codigoPublico: "SRP-5", estado: "TEMPORAL" });

    const resultado = await aprobarSinpe(comoPrisma(fake), "SRP-5");

    expect(resultado).toEqual({ ok: false, motivo: "ESTADO_INVALIDO" });
  });

  it("devuelve NO_ENCONTRADA si el codigo no existe", async () => {
    const fake = new FakePrisma();
    const resultado = await aprobarSinpe(comoPrisma(fake), "SRP-NOEXISTE");
    expect(resultado).toEqual({ ok: false, motivo: "NO_ENCONTRADA" });
  });
});

describe("rechazarSinpe", () => {
  it("6.9.8: rechaza una reserva PENDIENTE_VALIDACION_SINPE y registra el motivo", async () => {
    const fake = new FakePrisma();
    crearReserva(fake, { codigoPublico: "SRP-6", estado: "PENDIENTE_VALIDACION_SINPE" });

    const resultado = await rechazarSinpe(comoPrisma(fake), "SRP-6", "Comprobante ilegible");

    expect(resultado).toEqual({ ok: true });
    const reserva = fake.reservas.find((r) => r.codigoPublico === "SRP-6")!;
    expect(reserva.estado).toBe("RECHAZADA");
    expect(reserva.motivoRechazo).toBe("Comprobante ilegible");
    expect(reserva.rechazadaEn).toBeInstanceOf(Date);
  });

  it("devuelve ESTADO_INVALIDO si no esta pendiente de validacion", async () => {
    const fake = new FakePrisma();
    crearReserva(fake, { codigoPublico: "SRP-7", estado: "CONFIRMADA" });

    const resultado = await rechazarSinpe(comoPrisma(fake), "SRP-7", "motivo");

    expect(resultado).toEqual({ ok: false, motivo: "ESTADO_INVALIDO" });
  });
});
