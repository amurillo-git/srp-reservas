import { describe, expect, it } from "vitest";
import type { PrismaClient } from "@prisma/client";
import {
  crearExcepcion,
  eliminarExcepcion,
  establecerPlantillaSemanal,
  listarExcepciones,
  listarPlantillaSemanal,
} from "./horarios.service.js";
import { FakePrisma } from "./testing/fake-prisma.js";
import { listarHorasDisponibles } from "./availability.service.js";

// Pruebas de horarios.service.ts (14.3): gestion del horario semanal
// habitual (ScheduleTemplate) y de excepciones de calendario
// (ScheduleException) desde el panel administrativo. La lectura de estos
// mismos datos para calcular disponibilidad ya esta probada en
// availability.service.test.ts; aqui se prueba la escritura/validacion.

function comoPrisma(fake: FakePrisma): PrismaClient {
  return fake as unknown as PrismaClient;
}

const SERVICIO_ID = "svc-1";
const DOMINGO = 0;

describe("establecerPlantillaSemanal", () => {
  it("crea una plantilla nueva si el dia no tenia una", async () => {
    const fake = new FakePrisma();

    const resultado = await establecerPlantillaSemanal(comoPrisma(fake), SERVICIO_ID, DOMINGO, {
      horaApertura: "09:00", horaCierre: "16:00", almuerzoInicio: "12:00", almuerzoFin: "12:30",
    });

    expect(resultado.ok).toBe(true);
    expect(fake.plantillas).toHaveLength(1);
    expect(fake.plantillas[0]).toMatchObject({
      servicioId: SERVICIO_ID, diaSemana: DOMINGO, horaApertura: "09:00", horaCierre: "16:00", activo: true,
    });
  });

  it("actualiza (upsert) la plantilla existente del mismo dia en vez de duplicarla", async () => {
    const fake = new FakePrisma();
    fake.crearPlantilla({ id: "tpl-1", servicioId: SERVICIO_ID, diaSemana: DOMINGO, horaApertura: "09:00", horaCierre: "16:00" });

    const resultado = await establecerPlantillaSemanal(comoPrisma(fake), SERVICIO_ID, DOMINGO, {
      horaApertura: "10:00", horaCierre: "17:00",
    });

    expect(resultado.ok).toBe(true);
    expect(fake.plantillas).toHaveLength(1);
    expect(fake.plantillas[0]).toMatchObject({ horaApertura: "10:00", horaCierre: "17:00" });
  });

  it("permite desactivar un dia (activo: false) sin borrar la plantilla", async () => {
    const fake = new FakePrisma();
    fake.crearPlantilla({ id: "tpl-1", servicioId: SERVICIO_ID, diaSemana: DOMINGO, activo: true });

    const resultado = await establecerPlantillaSemanal(comoPrisma(fake), SERVICIO_ID, DOMINGO, {
      horaApertura: "09:00", horaCierre: "16:00", activo: false,
    });

    expect(resultado.ok).toBe(true);
    expect(fake.plantillas[0]!.activo).toBe(false);
  });

  it("rechaza un diaSemana fuera de 0-6", async () => {
    const fake = new FakePrisma();
    const resultado = await establecerPlantillaSemanal(comoPrisma(fake), SERVICIO_ID, 7, {
      horaApertura: "09:00", horaCierre: "16:00",
    });
    expect(resultado).toEqual({ ok: false, motivo: expect.stringContaining("diaSemana") });
    expect(fake.plantillas).toHaveLength(0);
  });

  it("rechaza horaApertura despues o igual a horaCierre", async () => {
    const fake = new FakePrisma();
    const resultado = await establecerPlantillaSemanal(comoPrisma(fake), SERVICIO_ID, DOMINGO, {
      horaApertura: "16:00", horaCierre: "16:00",
    });
    expect(resultado.ok).toBe(false);
    expect(fake.plantillas).toHaveLength(0);
  });

  it("rechaza un almuerzo fuera del rango de apertura/cierre", async () => {
    const fake = new FakePrisma();
    const resultado = await establecerPlantillaSemanal(comoPrisma(fake), SERVICIO_ID, DOMINGO, {
      horaApertura: "09:00", horaCierre: "16:00", almuerzoInicio: "16:00", almuerzoFin: "16:30",
    });
    expect(resultado.ok).toBe(false);
    expect(fake.plantillas).toHaveLength(0);
  });

  it("rechaza especificar solo almuerzoInicio sin almuerzoFin", async () => {
    const fake = new FakePrisma();
    const resultado = await establecerPlantillaSemanal(comoPrisma(fake), SERVICIO_ID, DOMINGO, {
      horaApertura: "09:00", horaCierre: "16:00", almuerzoInicio: "12:00",
    });
    expect(resultado.ok).toBe(false);
  });
});

describe("listarPlantillaSemanal", () => {
  it("devuelve las plantillas del servicio ordenadas por dia de semana", async () => {
    const fake = new FakePrisma();
    fake.crearPlantilla({ id: "tpl-sab", servicioId: SERVICIO_ID, diaSemana: 6, horaApertura: "09:00", horaCierre: "16:00" });
    fake.crearPlantilla({ id: "tpl-dom", servicioId: SERVICIO_ID, diaSemana: 0, horaApertura: "09:00", horaCierre: "16:00" });
    fake.crearPlantilla({ id: "tpl-otro", servicioId: "otro-servicio", diaSemana: 1, horaApertura: "09:00", horaCierre: "16:00" });

    const plantillas = await listarPlantillaSemanal(comoPrisma(fake), SERVICIO_ID);

    expect(plantillas.map((p) => p.diaSemana)).toEqual([0, 6]);
  });
});

describe("crearExcepcion", () => {
  it("HABILITADO requiere horaApertura y horaCierre", async () => {
    const fake = new FakePrisma();
    const sinHoras = await crearExcepcion(comoPrisma(fake), SERVICIO_ID, { fecha: "2026-12-25", tipo: "HABILITADO" });
    expect(sinHoras.ok).toBe(false);
    expect(fake.excepciones).toHaveLength(0);

    const conHoras = await crearExcepcion(comoPrisma(fake), SERVICIO_ID, {
      fecha: "2026-12-25", tipo: "HABILITADO", horaApertura: "10:00", horaCierre: "14:00", motivo: "Navidad especial",
    });
    expect(conHoras.ok).toBe(true);
    expect(fake.excepciones).toHaveLength(1);
    expect(fake.excepciones[0]).toMatchObject({ tipo: "HABILITADO", motivo: "Navidad especial" });
  });

  it("CERRADO no admite horas", async () => {
    const fake = new FakePrisma();
    const resultado = await crearExcepcion(comoPrisma(fake), SERVICIO_ID, {
      fecha: "2026-12-25", tipo: "CERRADO", horaApertura: "10:00",
    });
    expect(resultado.ok).toBe(false);

    const ok = await crearExcepcion(comoPrisma(fake), SERVICIO_ID, { fecha: "2026-12-25", tipo: "CERRADO", motivo: "Feriado" });
    expect(ok.ok).toBe(true);
    expect(fake.excepciones).toHaveLength(1);
  });

  it("MODIFICADO valida el mismo rango de horas/almuerzo que la plantilla semanal", async () => {
    const fake = new FakePrisma();
    const resultado = await crearExcepcion(comoPrisma(fake), SERVICIO_ID, {
      fecha: "2026-12-31", tipo: "MODIFICADO", horaApertura: "09:00", horaCierre: "12:00", almuerzoInicio: "13:00", almuerzoFin: "13:30",
    });
    expect(resultado.ok).toBe(false); // almuerzo fuera del rango apertura-cierre
    expect(fake.excepciones).toHaveLength(0);
  });
});

describe("listarExcepciones / eliminarExcepcion", () => {
  it("lista solo las excepciones del mes pedido", async () => {
    const fake = new FakePrisma();
    fake.crearExcepcion({ id: "e1", servicioId: SERVICIO_ID, fecha: new Date("2026-12-25T00:00:00.000Z"), tipo: "CERRADO" });
    fake.crearExcepcion({ id: "e2", servicioId: SERVICIO_ID, fecha: new Date("2026-12-31T00:00:00.000Z"), tipo: "MODIFICADO", horaApertura: "09:00", horaCierre: "12:00" });
    fake.crearExcepcion({ id: "e3", servicioId: SERVICIO_ID, fecha: new Date("2027-01-01T00:00:00.000Z"), tipo: "CERRADO" });

    const excepciones = await listarExcepciones(comoPrisma(fake), SERVICIO_ID, "2026-12");

    expect(excepciones.map((e) => e.fecha)).toEqual(["2026-12-25", "2026-12-31"]);
  });

  it("elimina una excepcion existente y devuelve NO_ENCONTRADA si no existe", async () => {
    const fake = new FakePrisma();
    fake.crearExcepcion({ id: "e1", servicioId: SERVICIO_ID, fecha: new Date("2026-12-25T00:00:00.000Z"), tipo: "CERRADO" });

    expect(await eliminarExcepcion(comoPrisma(fake), "e1")).toEqual({ ok: true });
    expect(fake.excepciones).toHaveLength(0);
    expect(await eliminarExcepcion(comoPrisma(fake), "e1")).toEqual({ ok: false, motivo: "NO_ENCONTRADA" });
  });
});

describe("integracion con availability.service.ts", () => {
  const FECHA_ISO = "2026-09-13"; // domingo (DOMINGO === 0)

  it("una plantilla semanal recien creada habilita horas ese dia", async () => {
    const fake = new FakePrisma();
    fake.crearServicio({ id: SERVICIO_ID });

    expect(await listarHorasDisponibles(comoPrisma(fake), SERVICIO_ID, FECHA_ISO, 2)).toEqual([]);

    await establecerPlantillaSemanal(comoPrisma(fake), SERVICIO_ID, DOMINGO, {
      horaApertura: "09:00", horaCierre: "10:00",
    });

    // 09:45 no entra: su lote necesitaria limpieza hasta las 10:15, fuera del cierre (6.1, 6.7).
    expect(await listarHorasDisponibles(comoPrisma(fake), SERVICIO_ID, FECHA_ISO, 2)).toEqual(["09:00", "09:15", "09:30"]);
  });

  it("una excepcion CERRADO anula la plantilla semanal para esa fecha", async () => {
    const fake = new FakePrisma();
    fake.crearServicio({ id: SERVICIO_ID });
    await establecerPlantillaSemanal(comoPrisma(fake), SERVICIO_ID, DOMINGO, { horaApertura: "09:00", horaCierre: "10:00" });
    await crearExcepcion(comoPrisma(fake), SERVICIO_ID, { fecha: FECHA_ISO, tipo: "CERRADO" });

    expect(await listarHorasDisponibles(comoPrisma(fake), SERVICIO_ID, FECHA_ISO, 2)).toEqual([]);
  });
});
