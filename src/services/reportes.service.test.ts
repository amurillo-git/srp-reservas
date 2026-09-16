import { describe, expect, it } from "vitest";
import type { PrismaClient } from "@prisma/client";
import {
  cancelacionesYReprogramaciones,
  depositosPorMetodoPago,
  ocupacionHeatsDelDia,
  participantesPorDia,
  reservasPorFechaYEstado,
  reservasVencidas,
  sinpePendientes,
} from "./reportes.service.js";
import { FakePrisma, type FilaReserva } from "./testing/fake-prisma.js";

// Pruebas de reportes.service.ts (25): reportes de solo lectura para el
// panel administrativo. Cada reporte toma un rango [desde, hasta] sobre el
// campo `fecha` de la reserva/heat (la fecha de la experiencia, no la fecha
// en que se creo/confirmo el registro), salvo sinpePendientes que es una
// foto del momento (no tiene sentido acotarla por fecha pasada).

function comoPrisma(fake: FakePrisma): PrismaClient {
  return fake as unknown as PrismaClient;
}

const SERVICIO_ID = "svc-1";

function crearReserva(fake: FakePrisma, datos: Partial<FilaReserva> & { id: string; fecha: Date }): FilaReserva {
  const reserva: FilaReserva = {
    codigoPublico: `SRP-${datos.id}`,
    servicioId: SERVICIO_ID,
    cantidadPersonas: 2,
    estado: "TEMPORAL",
    moneda: "CRC",
    montoTotal: 16000,
    montoDeposito: 8000,
    montoSaldo: 8000,
    claveIdempotencia: `idem-${datos.id}`,
    clienteNombre: "Cliente de prueba",
    clienteTelefono: "88888888",
    expiraEn: null,
    ...datos,
  };
  fake.reservas.push(reserva);
  return reserva;
}

describe("reservasPorFechaYEstado", () => {
  it("agrupa por fecha y estado dentro del rango, ignorando otros servicios y fechas fuera de rango", async () => {
    const fake = new FakePrisma();
    crearReserva(fake, { id: "1", fecha: new Date("2026-09-10"), estado: "CONFIRMADA" });
    crearReserva(fake, { id: "2", fecha: new Date("2026-09-10"), estado: "CONFIRMADA" });
    crearReserva(fake, { id: "3", fecha: new Date("2026-09-10"), estado: "CANCELADA" });
    crearReserva(fake, { id: "4", fecha: new Date("2026-09-11"), estado: "CONFIRMADA" });
    crearReserva(fake, { id: "5", fecha: new Date("2026-09-01"), estado: "CONFIRMADA" }); // fuera de rango
    crearReserva(fake, { id: "6", fecha: new Date("2026-09-10"), estado: "CONFIRMADA", servicioId: "otro-servicio" });

    const resultado = await reservasPorFechaYEstado(comoPrisma(fake), SERVICIO_ID, "2026-09-05", "2026-09-15");

    expect(resultado).toEqual([
      { fecha: "2026-09-10", estado: "CANCELADA", cantidad: 1 },
      { fecha: "2026-09-10", estado: "CONFIRMADA", cantidad: 2 },
      { fecha: "2026-09-11", estado: "CONFIRMADA", cantidad: 1 },
    ]);
  });

  it("devuelve un arreglo vacio si no hay reservas en el rango", async () => {
    const fake = new FakePrisma();
    expect(await reservasPorFechaYEstado(comoPrisma(fake), SERVICIO_ID, "2026-09-05", "2026-09-15")).toEqual([]);
  });
});

describe("participantesPorDia", () => {
  it("suma cantidadParticipantes de asignaciones ACTIVAS por dia, ignorando las LIBERADAS", async () => {
    const fake = new FakePrisma();
    const lote = fake.crearLote({
      id: "lote-1", servicioId: SERVICIO_ID, fecha: new Date("2026-09-10"),
      horaInicio: "09:00", horaFinUltimoHeat: "09:15", horaInicioLimpieza: "09:15", horaFinLimpieza: "09:30", cantidadHeats: 1,
    });
    fake.crearHeat({ id: "heat-1", loteId: lote.id, servicioId: SERVICIO_ID, fecha: new Date("2026-09-10"), horaInicio: "09:00", horaFin: "09:15", posicionEnLote: 1 });
    fake.crearHeat({ id: "heat-2", loteId: lote.id, servicioId: SERVICIO_ID, fecha: new Date("2026-09-11"), horaInicio: "09:00", horaFin: "09:15", posicionEnLote: 1 });
    fake.crearReservaConAsignacion({ heatId: "heat-1", servicioId: SERVICIO_ID, fecha: new Date("2026-09-10"), cantidadParticipantes: 3, estado: "CONFIRMADA" });
    fake.crearReservaConAsignacion({ heatId: "heat-1", servicioId: SERVICIO_ID, fecha: new Date("2026-09-10"), cantidadParticipantes: 2, estado: "CONFIRMADA" });
    fake.crearReservaConAsignacion({ heatId: "heat-2", servicioId: SERVICIO_ID, fecha: new Date("2026-09-11"), cantidadParticipantes: 4, estado: "CONFIRMADA" });
    fake.asignaciones[0]!.estado = "LIBERADA"; // no debe contar

    const resultado = await participantesPorDia(comoPrisma(fake), SERVICIO_ID, "2026-09-05", "2026-09-15");

    expect(resultado).toEqual([
      { fecha: "2026-09-10", totalParticipantes: 2 },
      { fecha: "2026-09-11", totalParticipantes: 4 },
    ]);
  });
});

describe("ocupacionHeatsDelDia", () => {
  it("devuelve ocupados/disponible por heat, ordenado por hora de inicio", async () => {
    const fake = new FakePrisma();
    const lote = fake.crearLote({
      id: "lote-1", servicioId: SERVICIO_ID, fecha: new Date("2026-09-10"),
      horaInicio: "09:00", horaFinUltimoHeat: "09:30", horaInicioLimpieza: "09:30", horaFinLimpieza: "09:45", cantidadHeats: 2,
    });
    fake.crearHeat({ id: "heat-2", loteId: lote.id, servicioId: SERVICIO_ID, fecha: new Date("2026-09-10"), horaInicio: "09:15", horaFin: "09:30", posicionEnLote: 2 });
    fake.crearHeat({ id: "heat-1", loteId: lote.id, servicioId: SERVICIO_ID, fecha: new Date("2026-09-10"), horaInicio: "09:00", horaFin: "09:15", posicionEnLote: 1 });
    fake.crearReservaConAsignacion({ heatId: "heat-1", servicioId: SERVICIO_ID, fecha: new Date("2026-09-10"), cantidadParticipantes: 3, estado: "CONFIRMADA" });

    const resultado = await ocupacionHeatsDelDia(comoPrisma(fake), SERVICIO_ID, "2026-09-10");

    expect(resultado).toEqual([
      { heatId: "heat-1", horaInicio: "09:00", capacidadMaxima: 5, ocupados: 3, disponible: 2 },
      { heatId: "heat-2", horaInicio: "09:15", capacidadMaxima: 5, ocupados: 0, disponible: 5 },
    ]);
  });
});

describe("depositosPorMetodoPago", () => {
  it("suma montoDeposito de reservas CONFIRMADA agrupado por TARJETA vs SINPE", async () => {
    const fake = new FakePrisma();
    crearReserva(fake, { id: "1", fecha: new Date("2026-09-10"), estado: "CONFIRMADA", montoDeposito: 5000, pagoTarjetaSesionId: "sesion-1" });
    crearReserva(fake, { id: "2", fecha: new Date("2026-09-10"), estado: "CONFIRMADA", montoDeposito: 3000, pagoTarjetaSesionId: "sesion-2" });
    crearReserva(fake, { id: "3", fecha: new Date("2026-09-10"), estado: "CONFIRMADA", montoDeposito: 4000 }); // SINPE (sin sesion de tarjeta)
    crearReserva(fake, { id: "4", fecha: new Date("2026-09-10"), estado: "TEMPORAL", montoDeposito: 9999 }); // no confirmada, no cuenta

    const resultado = await depositosPorMetodoPago(comoPrisma(fake), SERVICIO_ID, "2026-09-05", "2026-09-15");

    expect(resultado).toEqual([
      { metodo: "SINPE", totalDepositos: 4000, cantidadReservas: 1 },
      { metodo: "TARJETA", totalDepositos: 8000, cantidadReservas: 2 },
    ]);
  });
});

describe("sinpePendientes", () => {
  it("lista solo reservas PENDIENTE_VALIDACION_SINPE del servicio", async () => {
    const fake = new FakePrisma();
    crearReserva(fake, { id: "1", fecha: new Date("2026-09-10"), estado: "PENDIENTE_VALIDACION_SINPE" });
    crearReserva(fake, { id: "2", fecha: new Date("2026-09-11"), estado: "CONFIRMADA" });
    crearReserva(fake, { id: "3", fecha: new Date("2026-09-09"), estado: "PENDIENTE_VALIDACION_SINPE" });

    const resultado = await sinpePendientes(comoPrisma(fake), SERVICIO_ID);

    expect(resultado.map((r) => r.codigoPublico)).toEqual(["SRP-3", "SRP-1"]);
  });
});

describe("reservasVencidas", () => {
  it("cuenta y lista reservas EXPIRADA dentro del rango", async () => {
    const fake = new FakePrisma();
    crearReserva(fake, { id: "1", fecha: new Date("2026-09-10"), estado: "EXPIRADA" });
    crearReserva(fake, { id: "2", fecha: new Date("2026-09-10"), estado: "CONFIRMADA" });
    crearReserva(fake, { id: "3", fecha: new Date("2026-09-01"), estado: "EXPIRADA" }); // fuera de rango

    const resultado = await reservasVencidas(comoPrisma(fake), SERVICIO_ID, "2026-09-05", "2026-09-15");

    expect(resultado.map((r) => r.codigoPublico)).toEqual(["SRP-1"]);
  });
});

describe("cancelacionesYReprogramaciones", () => {
  it("cuenta cancelaciones (por estado) y suma vecesReprogramada en el rango", async () => {
    const fake = new FakePrisma();
    crearReserva(fake, { id: "1", fecha: new Date("2026-09-10"), estado: "CANCELADA" });
    crearReserva(fake, { id: "2", fecha: new Date("2026-09-10"), estado: "CONFIRMADA", vecesReprogramada: 2 });
    crearReserva(fake, { id: "3", fecha: new Date("2026-09-11"), estado: "CANCELADA" });
    crearReserva(fake, { id: "4", fecha: new Date("2026-09-11"), estado: "CONFIRMADA", vecesReprogramada: 1 });
    crearReserva(fake, { id: "5", fecha: new Date("2026-09-01"), estado: "CANCELADA" }); // fuera de rango

    const resultado = await cancelacionesYReprogramaciones(comoPrisma(fake), SERVICIO_ID, "2026-09-05", "2026-09-15");

    expect(resultado).toEqual({ cancelaciones: 2, reprogramaciones: 3 });
  });
});
