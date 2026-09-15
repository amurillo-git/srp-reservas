import { describe, expect, it } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { crearBloqueo, eliminarBloqueo, listarBloqueos } from "./bloqueos.service.js";
import { FakePrisma } from "./testing/fake-prisma.js";

function comoPrisma(fake: FakePrisma): PrismaClient {
  return fake as unknown as PrismaClient;
}

const SERVICIO_ID = "svc-1";
const FECHA_ISO = "2026-09-13";
const FECHA_DATE = new Date("2026-09-13T00:00:00.000Z");
const AHORA = new Date("2026-09-13T08:00:00.000Z");

describe("crearBloqueo", () => {
  it("crea el bloqueo si no hay reservas en conflicto", async () => {
    const fake = new FakePrisma();

    const resultado = await crearBloqueo(comoPrisma(fake), {
      servicioId: SERVICIO_ID, fecha: FECHA_ISO, horaInicio: "10:00", horaFin: "11:00", motivo: "Mantenimiento",
    });

    expect(resultado.ok).toBe(true);
    expect(fake.bloqueos).toHaveLength(1);
    expect(fake.bloqueos[0]).toMatchObject({ horaInicio: "10:00", horaFin: "11:00", motivo: "Mantenimiento" });
  });

  it("9.22: no crea el bloqueo si se solapa con una reserva confirmada, y devuelve el conflicto", async () => {
    const fake = new FakePrisma();
    const lote = fake.crearLote({
      id: "lote-1", servicioId: SERVICIO_ID, fecha: FECHA_DATE,
      horaInicio: "10:00", horaFinUltimoHeat: "10:15",
      horaInicioLimpieza: "10:15", horaFinLimpieza: "10:30", cantidadHeats: 1,
    });
    fake.crearHeat({ id: "heat-1", loteId: lote.id, servicioId: SERVICIO_ID, fecha: FECHA_DATE, horaInicio: "10:00", horaFin: "10:15", posicionEnLote: 1 });
    fake.crearReservaConAsignacion({ heatId: "heat-1", servicioId: SERVICIO_ID, fecha: FECHA_DATE, cantidadParticipantes: 5, estado: "CONFIRMADA" });

    const resultado = await crearBloqueo(comoPrisma(fake), {
      servicioId: SERVICIO_ID, fecha: FECHA_ISO, horaInicio: "09:45", horaFin: "10:30",
    });

    expect(resultado.ok).toBe(false);
    if (resultado.ok) return;
    expect(resultado.motivo).toBe("CONFLICTO");
    expect(resultado.reservasEnConflicto).toHaveLength(1);
    expect(resultado.reservasEnConflicto[0]!.cantidadPersonas).toBe(5);
    expect(fake.bloqueos).toHaveLength(0);
  });

  it("9.22: crea el bloqueo pese al conflicto si se pasa forzar:true", async () => {
    const fake = new FakePrisma();
    const lote = fake.crearLote({
      id: "lote-1", servicioId: SERVICIO_ID, fecha: FECHA_DATE,
      horaInicio: "10:00", horaFinUltimoHeat: "10:15",
      horaInicioLimpieza: "10:15", horaFinLimpieza: "10:30", cantidadHeats: 1,
    });
    fake.crearHeat({ id: "heat-1", loteId: lote.id, servicioId: SERVICIO_ID, fecha: FECHA_DATE, horaInicio: "10:00", horaFin: "10:15", posicionEnLote: 1 });
    fake.crearReservaConAsignacion({ heatId: "heat-1", servicioId: SERVICIO_ID, fecha: FECHA_DATE, cantidadParticipantes: 5, estado: "CONFIRMADA" });

    const resultado = await crearBloqueo(comoPrisma(fake), {
      servicioId: SERVICIO_ID, fecha: FECHA_ISO, horaInicio: "09:45", horaFin: "10:30", forzar: true,
    });

    expect(resultado.ok).toBe(true);
    expect(fake.bloqueos).toHaveLength(1);
  });

  it("no cuenta como conflicto una reserva TEMPORAL ya vencida", async () => {
    const fake = new FakePrisma();
    const lote = fake.crearLote({
      id: "lote-1", servicioId: SERVICIO_ID, fecha: FECHA_DATE,
      horaInicio: "10:00", horaFinUltimoHeat: "10:15",
      horaInicioLimpieza: "10:15", horaFinLimpieza: "10:30", cantidadHeats: 1,
    });
    fake.crearHeat({ id: "heat-1", loteId: lote.id, servicioId: SERVICIO_ID, fecha: FECHA_DATE, horaInicio: "10:00", horaFin: "10:15", posicionEnLote: 1 });
    fake.crearReservaConAsignacion({
      heatId: "heat-1", servicioId: SERVICIO_ID, fecha: FECHA_DATE, cantidadParticipantes: 5,
      estado: "TEMPORAL", expiraEn: new Date(AHORA.getTime() - 60_000),
    });

    const resultado = await crearBloqueo(
      comoPrisma(fake),
      { servicioId: SERVICIO_ID, fecha: FECHA_ISO, horaInicio: "10:00", horaFin: "10:15" },
      AHORA,
    );

    expect(resultado.ok).toBe(true);
  });

  it("no cuenta como conflicto una reserva RECHAZADA o CANCELADA", async () => {
    const fake = new FakePrisma();
    const lote = fake.crearLote({
      id: "lote-1", servicioId: SERVICIO_ID, fecha: FECHA_DATE,
      horaInicio: "10:00", horaFinUltimoHeat: "10:15",
      horaInicioLimpieza: "10:15", horaFinLimpieza: "10:30", cantidadHeats: 1,
    });
    fake.crearHeat({ id: "heat-1", loteId: lote.id, servicioId: SERVICIO_ID, fecha: FECHA_DATE, horaInicio: "10:00", horaFin: "10:15", posicionEnLote: 1 });
    fake.reservas.push({
      id: "res-rechazada", codigoPublico: "SRP-R", servicioId: SERVICIO_ID, fecha: FECHA_DATE,
      cantidadPersonas: 5, estado: "RECHAZADA", moneda: "CRC", montoTotal: 0, montoDeposito: 0, montoSaldo: 0,
      claveIdempotencia: "idem-r", clienteNombre: "Ana", clienteTelefono: "8888-0000", expiraEn: null,
    });
    fake.asignaciones.push({ id: "alloc-r", reservationId: "res-rechazada", heatId: "heat-1", cantidadParticipantes: 5, estado: "ACTIVA" });

    const resultado = await crearBloqueo(comoPrisma(fake), {
      servicioId: SERVICIO_ID, fecha: FECHA_ISO, horaInicio: "10:00", horaFin: "10:15",
    });

    expect(resultado.ok).toBe(true);
  });

  it("no considera conflicto un bloque que no se solapa en horario", async () => {
    const fake = new FakePrisma();
    const lote = fake.crearLote({
      id: "lote-1", servicioId: SERVICIO_ID, fecha: FECHA_DATE,
      horaInicio: "10:00", horaFinUltimoHeat: "10:15",
      horaInicioLimpieza: "10:15", horaFinLimpieza: "10:30", cantidadHeats: 1,
    });
    fake.crearHeat({ id: "heat-1", loteId: lote.id, servicioId: SERVICIO_ID, fecha: FECHA_DATE, horaInicio: "10:00", horaFin: "10:15", posicionEnLote: 1 });
    fake.crearReservaConAsignacion({ heatId: "heat-1", servicioId: SERVICIO_ID, fecha: FECHA_DATE, cantidadParticipantes: 5, estado: "CONFIRMADA" });

    const resultado = await crearBloqueo(comoPrisma(fake), {
      servicioId: SERVICIO_ID, fecha: FECHA_ISO, horaInicio: "11:00", horaFin: "12:00",
    });

    expect(resultado.ok).toBe(true);
  });
});

describe("listarBloqueos / eliminarBloqueo", () => {
  it("lista los bloqueos del dia y servicio pedidos", async () => {
    const fake = new FakePrisma();
    fake.crearBloqueo({ id: "b1", servicioId: SERVICIO_ID, fecha: FECHA_DATE, horaInicio: "10:00", horaFin: "11:00", motivo: "Evento privado" });

    const bloqueos = await listarBloqueos(comoPrisma(fake), SERVICIO_ID, FECHA_ISO);

    expect(bloqueos).toEqual([{ id: "b1", fecha: FECHA_ISO, horaInicio: "10:00", horaFin: "11:00", motivo: "Evento privado" }]);
  });

  it("elimina un bloqueo existente", async () => {
    const fake = new FakePrisma();
    fake.crearBloqueo({ id: "b1", servicioId: SERVICIO_ID, fecha: FECHA_DATE, horaInicio: "10:00", horaFin: "11:00" });

    const resultado = await eliminarBloqueo(comoPrisma(fake), "b1");

    expect(resultado).toEqual({ ok: true });
    expect(fake.bloqueos).toHaveLength(0);
  });

  it("devuelve NO_ENCONTRADO si el bloqueo no existe", async () => {
    const fake = new FakePrisma();
    expect(await eliminarBloqueo(comoPrisma(fake), "no-existe")).toEqual({ ok: false, motivo: "NO_ENCONTRADO" });
  });
});
