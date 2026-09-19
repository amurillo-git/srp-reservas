import { describe, expect, it } from "vitest";
import type { PrismaClient } from "@prisma/client";
import {
  buscarReservas,
  cancelacionesYReprogramaciones,
  depositosPorMetodoPago,
  ocupacionHeatsDelDia,
  participantesPorDia,
  reservasDelDia,
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

describe("reservasDelDia", () => {
  it("lista todas las reservas de la fecha sin filtrar por estado", async () => {
    const fake = new FakePrisma();
    crearReserva(fake, { id: "1", fecha: new Date("2026-09-10"), estado: "CONFIRMADA" });
    crearReserva(fake, { id: "2", fecha: new Date("2026-09-10"), estado: "TEMPORAL" });
    crearReserva(fake, { id: "3", fecha: new Date("2026-09-11"), estado: "CONFIRMADA" }); // otro dia
    crearReserva(fake, { id: "4", fecha: new Date("2026-09-10"), estado: "CONFIRMADA", servicioId: "otro-servicio" });

    const resultado = await reservasDelDia(comoPrisma(fake), SERVICIO_ID, "2026-09-10");

    expect(resultado.map((r) => ({ codigoPublico: r.codigoPublico, estado: r.estado }))).toEqual([
      { codigoPublico: "SRP-1", estado: "CONFIRMADA" },
      { codigoPublico: "SRP-2", estado: "TEMPORAL" },
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

  it("28: incluye el monto esperado y los datos del comprobante reportado", async () => {
    const fake = new FakePrisma();
    const reserva = crearReserva(fake, {
      id: "1", fecha: new Date("2026-09-10"), estado: "PENDIENTE_VALIDACION_SINPE",
      montoTotal: 20000, montoDeposito: 10000, moneda: "CRC",
    });
    await fake.sinpeEvidence.create({
      data: { reservationId: reserva.id, nombrePagador: "Ana Perez", numeroOrigen: "8888-0000", referencia: "REF-1" },
    });

    const resultado = await sinpePendientes(comoPrisma(fake), SERVICIO_ID);

    expect(resultado[0]).toMatchObject({
      montoTotal: 20000, montoDeposito: 10000, moneda: "CRC",
      nombrePagador: "Ana Perez", numeroOrigen: "8888-0000", referencia: "REF-1",
    });
  });

  it("28: nombrePagador/numeroOrigen/referencia quedan null si no se reportaron", async () => {
    const fake = new FakePrisma();
    const reserva = crearReserva(fake, { id: "1", fecha: new Date("2026-09-10"), estado: "PENDIENTE_VALIDACION_SINPE" });
    await fake.sinpeEvidence.create({ data: { reservationId: reserva.id } });

    const resultado = await sinpePendientes(comoPrisma(fake), SERVICIO_ID);

    expect(resultado[0]!.nombrePagador).toBeNull();
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

describe("buscarReservas", () => {
  it("sin filtros devuelve las reservas del servicio, mas recientes primero", async () => {
    const fake = new FakePrisma();
    crearReserva(fake, { id: "1", fecha: new Date("2026-09-10") });
    crearReserva(fake, { id: "2", fecha: new Date("2026-09-12") });
    crearReserva(fake, { id: "3", fecha: new Date("2026-09-11"), servicioId: "otro-servicio" });

    const resultado = await buscarReservas(comoPrisma(fake), SERVICIO_ID, {});

    expect(resultado.map((r) => r.codigoPublico)).toEqual(["SRP-2", "SRP-1"]);
  });

  it("filtra por texto libre que coincide con codigo, nombre o telefono, sin distinguir mayusculas", async () => {
    const fake = new FakePrisma();
    crearReserva(fake, { id: "1", fecha: new Date("2026-09-10"), clienteNombre: "Ana Perez", clienteTelefono: "88881111" });
    crearReserva(fake, { id: "2", fecha: new Date("2026-09-10"), clienteNombre: "Beto Soto", clienteTelefono: "88882222" });

    expect((await buscarReservas(comoPrisma(fake), SERVICIO_ID, { q: "srp-1" })).map((r) => r.codigoPublico)).toEqual([
      "SRP-1",
    ]);
    expect((await buscarReservas(comoPrisma(fake), SERVICIO_ID, { q: "beto" })).map((r) => r.codigoPublico)).toEqual([
      "SRP-2",
    ]);
    expect((await buscarReservas(comoPrisma(fake), SERVICIO_ID, { q: "1111" })).map((r) => r.codigoPublico)).toEqual([
      "SRP-1",
    ]);
  });

  it("filtra por estado", async () => {
    const fake = new FakePrisma();
    crearReserva(fake, { id: "1", fecha: new Date("2026-09-10"), estado: "CONFIRMADA" });
    crearReserva(fake, { id: "2", fecha: new Date("2026-09-10"), estado: "CANCELADA" });

    const resultado = await buscarReservas(comoPrisma(fake), SERVICIO_ID, { estado: "CANCELADA" });

    expect(resultado.map((r) => r.codigoPublico)).toEqual(["SRP-2"]);
  });

  it("filtra por rango de fechas, aceptando solo desde o solo hasta", async () => {
    const fake = new FakePrisma();
    crearReserva(fake, { id: "1", fecha: new Date("2026-09-05") });
    crearReserva(fake, { id: "2", fecha: new Date("2026-09-10") });
    crearReserva(fake, { id: "3", fecha: new Date("2026-09-15") });

    const desde = await buscarReservas(comoPrisma(fake), SERVICIO_ID, { desde: "2026-09-10" });
    expect(desde.map((r) => r.codigoPublico).sort()).toEqual(["SRP-2", "SRP-3"]);

    const hasta = await buscarReservas(comoPrisma(fake), SERVICIO_ID, { hasta: "2026-09-10" });
    expect(hasta.map((r) => r.codigoPublico).sort()).toEqual(["SRP-1", "SRP-2"]);
  });

  it("combina texto libre y estado", async () => {
    const fake = new FakePrisma();
    crearReserva(fake, { id: "1", fecha: new Date("2026-09-10"), estado: "CONFIRMADA", clienteNombre: "Ana" });
    crearReserva(fake, { id: "2", fecha: new Date("2026-09-10"), estado: "CANCELADA", clienteNombre: "Ana" });

    const resultado = await buscarReservas(comoPrisma(fake), SERVICIO_ID, { q: "ana", estado: "CONFIRMADA" });

    expect(resultado.map((r) => r.codigoPublico)).toEqual(["SRP-1"]);
  });

  it("incluye vecesReprogramada en cada resultado", async () => {
    const fake = new FakePrisma();
    crearReserva(fake, { id: "1", fecha: new Date("2026-09-10"), vecesReprogramada: 2 });

    const resultado = await buscarReservas(comoPrisma(fake), SERVICIO_ID, {});

    expect(resultado[0]!.vecesReprogramada).toBe(2);
  });

  it("limita a 100 resultados", async () => {
    const fake = new FakePrisma();
    for (let i = 0; i < 150; i++) {
      crearReserva(fake, { id: `${i}`, fecha: new Date(2026, 8, 1 + (i % 28)) });
    }

    const resultado = await buscarReservas(comoPrisma(fake), SERVICIO_ID, {});

    expect(resultado).toHaveLength(100);
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
