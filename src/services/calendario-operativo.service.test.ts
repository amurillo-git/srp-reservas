import { describe, expect, it } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { calendarioOperativoDelDia } from "./calendario-operativo.service.js";
import { FakePrisma } from "./testing/fake-prisma.js";

// Pruebas de calendario-operativo.service.ts (14.2): vista operativa de un
// dia para el panel administrativo. Reutiliza resolverVentanasDelDia
// (availability.service.ts) y listarBloqueos (bloqueos.service.ts), asi que
// aqui NO se reprueba esa logica (ya cubierta en sus propios archivos de
// prueba) — solo que calendarioOperativoDelDia arma correctamente el arbol
// lotes -> heats -> reservas y las combina con ventanas/bloqueos.

function comoPrisma(fake: FakePrisma): PrismaClient {
  return fake as unknown as PrismaClient;
}

const SERVICIO_ID = "svc-1";
const DIA_SEMANA_DOMINGO = 0; // 2026-09-13 es domingo

function crearFixtureConHorario(fake: FakePrisma): void {
  fake.crearServicio({ id: SERVICIO_ID });
  fake.crearPlantilla({
    id: "tpl-1", servicioId: SERVICIO_ID, diaSemana: DIA_SEMANA_DOMINGO,
    horaApertura: "09:00", horaCierre: "16:00", almuerzoInicio: "12:00", almuerzoFin: "12:30", activo: true,
  });
}

describe("calendarioOperativoDelDia", () => {
  it("arma los lotes con sus heats, capacidad y las reservas ACTIVAS que comparte cada uno", async () => {
    const fake = new FakePrisma();
    crearFixtureConHorario(fake);
    const lote = fake.crearLote({
      id: "lote-1", servicioId: SERVICIO_ID, fecha: new Date("2026-09-13"),
      horaInicio: "09:00", horaFinUltimoHeat: "09:15", horaInicioLimpieza: "09:15", horaFinLimpieza: "09:30", cantidadHeats: 1,
    });
    fake.crearHeat({ id: "heat-1", loteId: lote.id, servicioId: SERVICIO_ID, fecha: new Date("2026-09-13"), horaInicio: "09:00", horaFin: "09:15", posicionEnLote: 1 });
    const { reserva } = fake.crearReservaConAsignacion({
      heatId: "heat-1", servicioId: SERVICIO_ID, fecha: new Date("2026-09-13"), cantidadParticipantes: 3, estado: "CONFIRMADA",
    });
    const { asignacion: asignacionLiberada } = fake.crearReservaConAsignacion({
      heatId: "heat-1", servicioId: SERVICIO_ID, fecha: new Date("2026-09-13"), cantidadParticipantes: 2, estado: "CONFIRMADA",
    });
    asignacionLiberada.estado = "LIBERADA"; // no debe aparecer

    const resultado = await calendarioOperativoDelDia(comoPrisma(fake), SERVICIO_ID, "2026-09-13");

    expect(resultado.lotes).toEqual([
      {
        loteId: "lote-1", horaInicio: "09:00", horaFinUltimoHeat: "09:15",
        horaInicioLimpieza: "09:15", horaFinLimpieza: "09:30",
        heats: [
          {
            heatId: "heat-1", horaInicio: "09:00", horaFin: "09:15", capacidadMaxima: 5,
            reservas: [{ codigoPublico: reserva.codigoPublico, cantidadPersonas: 3, estado: "CONFIRMADA" }],
          },
        ],
      },
    ]);
  });

  it("incluye la ventana horaria del dia (apertura/almuerzo) resuelta igual que el motor de disponibilidad", async () => {
    const fake = new FakePrisma();
    crearFixtureConHorario(fake);

    const resultado = await calendarioOperativoDelDia(comoPrisma(fake), SERVICIO_ID, "2026-09-13");

    expect(resultado.ventanas).toEqual([
      { horaApertura: "09:00", horaCierre: "16:00", almuerzoInicio: "12:00", almuerzoFin: "12:30" },
    ]);
  });

  it("devuelve ventanas vacio si el dia esta cerrado (sin plantilla activa ni excepcion)", async () => {
    const fake = new FakePrisma();
    fake.crearServicio({ id: SERVICIO_ID });

    const resultado = await calendarioOperativoDelDia(comoPrisma(fake), SERVICIO_ID, "2026-09-14"); // lunes, sin plantilla

    expect(resultado.ventanas).toEqual([]);
    expect(resultado.lotes).toEqual([]);
  });

  it("incluye los bloqueos administrativos del dia", async () => {
    const fake = new FakePrisma();
    crearFixtureConHorario(fake);
    fake.crearBloqueo({ id: "blk-1", servicioId: SERVICIO_ID, fecha: new Date("2026-09-13"), horaInicio: "10:00", horaFin: "10:30", motivo: "Mantenimiento" });

    const resultado = await calendarioOperativoDelDia(comoPrisma(fake), SERVICIO_ID, "2026-09-13");

    expect(resultado.bloqueos).toEqual([
      { id: "blk-1", fecha: "2026-09-13", horaInicio: "10:00", horaFin: "10:30", motivo: "Mantenimiento" },
    ]);
  });

  it("ignora lotes, heats y bloqueos de otro servicio", async () => {
    const fake = new FakePrisma();
    crearFixtureConHorario(fake);
    const loteOtro = fake.crearLote({
      id: "lote-otro", servicioId: "otro-servicio", fecha: new Date("2026-09-13"),
      horaInicio: "09:00", horaFinUltimoHeat: "09:15", horaInicioLimpieza: "09:15", horaFinLimpieza: "09:30", cantidadHeats: 1,
    });
    fake.crearHeat({ id: "heat-otro", loteId: loteOtro.id, servicioId: "otro-servicio", fecha: new Date("2026-09-13"), horaInicio: "09:00", horaFin: "09:15", posicionEnLote: 1 });
    fake.crearBloqueo({ id: "blk-otro", servicioId: "otro-servicio", fecha: new Date("2026-09-13"), horaInicio: "10:00", horaFin: "10:30" });

    const resultado = await calendarioOperativoDelDia(comoPrisma(fake), SERVICIO_ID, "2026-09-13");

    expect(resultado.lotes).toEqual([]);
    expect(resultado.bloqueos).toEqual([]);
  });

  it("ordena los lotes por hora de inicio", async () => {
    const fake = new FakePrisma();
    crearFixtureConHorario(fake);
    const loteB = fake.crearLote({
      id: "lote-b", servicioId: SERVICIO_ID, fecha: new Date("2026-09-13"),
      horaInicio: "10:00", horaFinUltimoHeat: "10:15", horaInicioLimpieza: "10:15", horaFinLimpieza: "10:30", cantidadHeats: 1,
    });
    const loteA = fake.crearLote({
      id: "lote-a", servicioId: SERVICIO_ID, fecha: new Date("2026-09-13"),
      horaInicio: "09:00", horaFinUltimoHeat: "09:15", horaInicioLimpieza: "09:15", horaFinLimpieza: "09:30", cantidadHeats: 1,
    });
    fake.crearHeat({ id: "heat-b", loteId: loteB.id, servicioId: SERVICIO_ID, fecha: new Date("2026-09-13"), horaInicio: "10:00", horaFin: "10:15", posicionEnLote: 1 });
    fake.crearHeat({ id: "heat-a", loteId: loteA.id, servicioId: SERVICIO_ID, fecha: new Date("2026-09-13"), horaInicio: "09:00", horaFin: "09:15", posicionEnLote: 1 });

    const resultado = await calendarioOperativoDelDia(comoPrisma(fake), SERVICIO_ID, "2026-09-13");

    expect(resultado.lotes.map((l) => l.loteId)).toEqual(["lote-a", "lote-b"]);
  });
});
