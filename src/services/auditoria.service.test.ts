import { describe, expect, it } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { listarEventos, registrarEvento } from "./auditoria.service.js";
import { FakePrisma, type FilaEventoAuditoria } from "./testing/fake-prisma.js";

// Pruebas de auditoria.service.ts (21): registrar y listar eventos de
// auditoria. Solo-escritura + lectura: no hay actualizar ni eliminar (los
// registros no deben modificarse desde la aplicacion, ver propuesta.md 21).

function comoPrisma(fake: FakePrisma): PrismaClient {
  return fake as unknown as PrismaClient;
}

const ACTOR = { userId: "user-1", email: "admin@srp.test" };

describe("registrarEvento", () => {
  it("guarda el actor, la accion, el objeto y los valores nuevos/anteriores", async () => {
    const fake = new FakePrisma();

    await registrarEvento(comoPrisma(fake), ACTOR, {
      accion: "RESERVA_CANCELADA",
      objetoTipo: "RESERVA",
      objetoId: "SRP-1",
      valoresAnteriores: { estado: "CONFIRMADA" },
      valoresNuevos: { estado: "CANCELADA" },
    });

    expect(fake.eventosAuditoria).toHaveLength(1);
    expect(fake.eventosAuditoria[0]).toMatchObject({
      actorUserId: "user-1",
      actorEmail: "admin@srp.test",
      accion: "RESERVA_CANCELADA",
      objetoTipo: "RESERVA",
      objetoId: "SRP-1",
      valoresAnteriores: { estado: "CONFIRMADA" },
      valoresNuevos: { estado: "CANCELADA" },
    });
  });

  it("permite omitir valoresAnteriores cuando no esta disponible sin consultas extra", async () => {
    const fake = new FakePrisma();

    await registrarEvento(comoPrisma(fake), ACTOR, {
      accion: "BLOQUEO_CREADO",
      objetoTipo: "BLOQUEO",
      objetoId: "blk-1",
      valoresNuevos: { fecha: "2026-09-20", horaInicio: "10:00", horaFin: "11:00" },
    });

    expect(fake.eventosAuditoria[0]!.valoresAnteriores).toBeUndefined();
  });
});

function crearEvento(fake: FakePrisma, datos: Partial<FilaEventoAuditoria> & { id: string; creadoEn: Date }): void {
  fake.eventosAuditoria.push({
    actorUserId: "user-1", actorEmail: "admin@srp.test", accion: "RESERVA_CANCELADA",
    objetoTipo: "RESERVA", objetoId: "SRP-1", valoresAnteriores: null, valoresNuevos: null,
    ...datos,
  });
}

describe("listarEventos", () => {
  it("devuelve los eventos mas recientes primero", async () => {
    const fake = new FakePrisma();
    crearEvento(fake, { id: "1", creadoEn: new Date("2026-09-10T10:00:00Z") });
    crearEvento(fake, { id: "2", creadoEn: new Date("2026-09-12T10:00:00Z") });

    const resultado = await listarEventos(comoPrisma(fake), {});

    expect(resultado.map((e) => e.id)).toEqual(["2", "1"]);
  });

  it("filtra por accion y por objetoId", async () => {
    const fake = new FakePrisma();
    crearEvento(fake, { id: "1", creadoEn: new Date("2026-09-10T10:00:00Z"), accion: "RESERVA_CANCELADA", objetoId: "SRP-1" });
    crearEvento(fake, { id: "2", creadoEn: new Date("2026-09-10T11:00:00Z"), accion: "RESERVA_REPROGRAMADA", objetoId: "SRP-2" });

    expect((await listarEventos(comoPrisma(fake), { accion: "RESERVA_REPROGRAMADA" })).map((e) => e.id)).toEqual(["2"]);
    expect((await listarEventos(comoPrisma(fake), { objetoId: "SRP-1" })).map((e) => e.id)).toEqual(["1"]);
  });

  it("filtra por rango de fechas", async () => {
    const fake = new FakePrisma();
    crearEvento(fake, { id: "1", creadoEn: new Date("2026-09-05T10:00:00Z") });
    crearEvento(fake, { id: "2", creadoEn: new Date("2026-09-15T10:00:00Z") });

    const resultado = await listarEventos(comoPrisma(fake), { desde: "2026-09-10", hasta: "2026-09-20" });

    expect(resultado.map((e) => e.id)).toEqual(["2"]);
  });

  it("incluye el actor y los valores del evento", async () => {
    const fake = new FakePrisma();
    crearEvento(fake, {
      id: "1", creadoEn: new Date("2026-09-10T10:00:00Z"),
      valoresAnteriores: { estado: "CONFIRMADA" }, valoresNuevos: { estado: "CANCELADA" },
    });

    const [evento] = await listarEventos(comoPrisma(fake), {});

    expect(evento).toMatchObject({
      actorEmail: "admin@srp.test",
      accion: "RESERVA_CANCELADA",
      objetoTipo: "RESERVA",
      objetoId: "SRP-1",
      valoresAnteriores: { estado: "CONFIRMADA" },
      valoresNuevos: { estado: "CANCELADA" },
    });
  });
});
