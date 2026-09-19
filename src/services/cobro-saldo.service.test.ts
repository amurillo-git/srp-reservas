import { describe, expect, it } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { marcarSaldoPagadoManual } from "./cobro-saldo.service.js";
import { establecerModoSinpe } from "./configuracion-pago.service.js";
import { FakePrisma, type FilaReserva } from "./testing/fake-prisma.js";

function comoPrisma(fake: FakePrisma): PrismaClient {
  return fake as unknown as PrismaClient;
}

function crearReservaConfirmada(fake: FakePrisma, datos: Partial<FilaReserva> = {}): FilaReserva {
  const reserva: FilaReserva = {
    id: "res-1",
    codigoPublico: "SRP-0001",
    servicioId: "svc-1",
    fecha: new Date("2026-12-25T00:00:00.000Z"),
    cantidadPersonas: 2,
    estado: "CONFIRMADA",
    moneda: "CRC",
    montoTotal: 16000,
    montoDeposito: 8000,
    montoSaldo: 8000,
    claveIdempotencia: "idem-1",
    clienteNombre: "Ana Mora",
    clienteTelefono: "88888888",
    expiraEn: null,
    confirmadaEn: new Date(),
    ...datos,
  };
  fake.reservas.push(reserva);
  return reserva;
}

describe("marcarSaldoPagadoManual", () => {
  it("25: marca el saldo pagado y la reserva pasa a PAGADA", async () => {
    const fake = new FakePrisma();
    crearReservaConfirmada(fake);

    const resultado = await marcarSaldoPagadoManual(comoPrisma(fake), "SRP-0001");

    expect(resultado).toEqual({ ok: true });
    expect(fake.reservas[0]!.estado).toBe("PAGADA");
    expect(fake.payments).toHaveLength(1);
    expect(fake.payments[0]).toMatchObject({
      reservationId: "res-1", tipo: "SALDO", monto: 8000, moneda: "CRC",
      metodo: "SINPE_MANUAL", estado: "PAGADO",
    });
    expect(fake.payments[0]!.pagadoEn).toBeInstanceOf(Date);
  });

  it("es idempotente: una reserva ya PAGADA no se reprocesa", async () => {
    const fake = new FakePrisma();
    crearReservaConfirmada(fake, { estado: "PAGADA" });

    const resultado = await marcarSaldoPagadoManual(comoPrisma(fake), "SRP-0001");

    expect(resultado).toEqual({ ok: true });
    expect(fake.payments).toHaveLength(0);
  });

  it("devuelve ESTADO_INVALIDO si la reserva no esta CONFIRMADA", async () => {
    const fake = new FakePrisma();
    crearReservaConfirmada(fake, { estado: "TEMPORAL" });

    const resultado = await marcarSaldoPagadoManual(comoPrisma(fake), "SRP-0001");

    expect(resultado).toEqual({ ok: false, motivo: "ESTADO_INVALIDO" });
  });

  it("devuelve NO_ENCONTRADA si el codigo no existe", async () => {
    const fake = new FakePrisma();
    const resultado = await marcarSaldoPagadoManual(comoPrisma(fake), "SRP-NOEXISTE");
    expect(resultado).toEqual({ ok: false, motivo: "NO_ENCONTRADA" });
  });

  it("devuelve MODO_INCORRECTO si el modo global es ONVO", async () => {
    const fake = new FakePrisma();
    await establecerModoSinpe(comoPrisma(fake), "ONVO");
    crearReservaConfirmada(fake);

    const resultado = await marcarSaldoPagadoManual(comoPrisma(fake), "SRP-0001");

    expect(resultado).toEqual({ ok: false, motivo: "MODO_INCORRECTO" });
  });
});
