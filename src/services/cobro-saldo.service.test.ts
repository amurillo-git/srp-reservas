import { describe, expect, it } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { ajustarAsistentesReales, marcarSaldoPagadoManual } from "./cobro-saldo.service.js";
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
    expect(fake.reservas[0]!.montoSaldo).toBe(0);
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

describe("ajustarAsistentesReales", () => {
  function crearServicioBase(fake: FakePrisma) {
    fake.crearServicio({
      id: "svc-1", moneda: "CRC",
      precioPorPersonaGrupoPequeno: 5000, precioPorPersonaGrupoGrande: 4000, porcentajeDeposito: 50,
    });
  }

  it("28: recalcula el total y el saldo cuando llegan menos personas (mismo escalon de tarifa)", async () => {
    const fake = new FakePrisma();
    crearServicioBase(fake);
    crearReservaConfirmada(fake, { cantidadPersonas: 8, montoTotal: 32000, montoDeposito: 20000, montoSaldo: 12000 });

    const resultado = await ajustarAsistentesReales(comoPrisma(fake), "SRP-0001", 5);

    expect(resultado).toEqual({ ok: true });
    const reserva = fake.reservas[0]!;
    expect(reserva.cantidadPersonas).toBe(5);
    expect(reserva.montoTotal).toBe(20000); // 5 x 4000 (sigue grupo grande, umbral 5)
    expect(reserva.montoDeposito).toBe(20000); // intacto
    expect(reserva.montoSaldo).toBe(0); // 20000 - 20000
  });

  it("28: recalcula usando la tarifa de grupo pequeno si la nueva cantidad cruza el umbral", async () => {
    const fake = new FakePrisma();
    crearServicioBase(fake);
    crearReservaConfirmada(fake, { cantidadPersonas: 6, montoTotal: 24000, montoDeposito: 12000, montoSaldo: 12000 });

    const resultado = await ajustarAsistentesReales(comoPrisma(fake), "SRP-0001", 3);

    expect(resultado).toEqual({ ok: true });
    const reserva = fake.reservas[0]!;
    expect(reserva.montoTotal).toBe(15000); // 3 x 5000 (grupo pequeno, < umbral 5)
    expect(reserva.montoSaldo).toBe(3000); // 15000 - 12000
  });

  it("28: si el nuevo total queda por debajo de lo ya pagado, el saldo pendiente es 0 (sin credito)", async () => {
    const fake = new FakePrisma();
    crearServicioBase(fake);
    crearReservaConfirmada(fake, { cantidadPersonas: 8, montoTotal: 32000, montoDeposito: 20000, montoSaldo: 12000 });

    const resultado = await ajustarAsistentesReales(comoPrisma(fake), "SRP-0001", 1);

    expect(resultado).toEqual({ ok: true });
    const reserva = fake.reservas[0]!;
    expect(reserva.montoTotal).toBe(5000); // 1 x 5000
    expect(reserva.montoDeposito).toBe(20000); // intacto, mayor al nuevo total
    expect(reserva.montoSaldo).toBe(0);
  });

  it("no hace nada si la cantidad real es igual a la reservada", async () => {
    const fake = new FakePrisma();
    crearServicioBase(fake);
    crearReservaConfirmada(fake, { cantidadPersonas: 5, montoTotal: 20000, montoDeposito: 10000, montoSaldo: 10000 });

    const resultado = await ajustarAsistentesReales(comoPrisma(fake), "SRP-0001", 5);

    expect(resultado).toEqual({ ok: true });
    expect(fake.reservas[0]!.montoSaldo).toBe(10000);
  });

  it("devuelve CANTIDAD_INVALIDA si la cantidad real es mayor a la reservada", async () => {
    const fake = new FakePrisma();
    crearServicioBase(fake);
    crearReservaConfirmada(fake, { cantidadPersonas: 5 });

    const resultado = await ajustarAsistentesReales(comoPrisma(fake), "SRP-0001", 6);

    expect(resultado).toEqual({ ok: false, motivo: "CANTIDAD_INVALIDA" });
  });

  it("devuelve CANTIDAD_INVALIDA si la cantidad real es 0 o no es entera", async () => {
    const fake = new FakePrisma();
    crearServicioBase(fake);
    crearReservaConfirmada(fake, { cantidadPersonas: 5 });

    expect(await ajustarAsistentesReales(comoPrisma(fake), "SRP-0001", 0)).toEqual({ ok: false, motivo: "CANTIDAD_INVALIDA" });
    expect(await ajustarAsistentesReales(comoPrisma(fake), "SRP-0001", 2.5)).toEqual({ ok: false, motivo: "CANTIDAD_INVALIDA" });
  });

  it("devuelve ESTADO_INVALIDO si la reserva no esta CONFIRMADA", async () => {
    const fake = new FakePrisma();
    crearServicioBase(fake);
    crearReservaConfirmada(fake, { estado: "PAGADA", cantidadPersonas: 5 });

    const resultado = await ajustarAsistentesReales(comoPrisma(fake), "SRP-0001", 3);

    expect(resultado).toEqual({ ok: false, motivo: "ESTADO_INVALIDO" });
  });

  it("devuelve NO_ENCONTRADA si el codigo no existe", async () => {
    const fake = new FakePrisma();
    const resultado = await ajustarAsistentesReales(comoPrisma(fake), "SRP-NOEXISTE", 3);
    expect(resultado).toEqual({ ok: false, motivo: "NO_ENCONTRADA" });
  });
});
