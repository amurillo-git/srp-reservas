import { describe, expect, it } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { buscarReservasPorTelefonoYFecha, normalizarTelefono } from "./consulta-publica.service.js";
import { FakePrisma } from "./testing/fake-prisma.js";

function comoPrisma(fake: FakePrisma): PrismaClient {
  return fake as unknown as PrismaClient;
}

const FECHA = "2026-11-21";
const FECHA_DATE = new Date("2026-11-21T00:00:00.000Z");
const OTRA_FECHA_DATE = new Date("2026-11-22T00:00:00.000Z");

describe("normalizarTelefono", () => {
  it.each([
    ["6068-7547", "60687547"],
    ["60687547", "60687547"],
    ["+506 6068 7547", "60687547"],
    ["(506) 6068-7547", "60687547"],
    ["506-6068-7547", "60687547"],
    ["  6068 7547  ", "60687547"],
  ])("%s -> %s", (entrada, esperado) => {
    expect(normalizarTelefono(entrada)).toBe(esperado);
  });

  it.each([[""], ["   "], ["abc"], ["6068"], ["1234567"]])("%j no es un telefono valido", (entrada) => {
    expect(normalizarTelefono(entrada)).toBeNull();
  });
});

/** Reserva en un heat de `hora` con el telefono y fecha indicados. */
function crearReserva(
  fake: FakePrisma,
  idHeat: string,
  hora: string,
  datos: { telefono: string; fecha?: Date; estado?: string; nombre?: string },
) {
  const fecha = datos.fecha ?? FECHA_DATE;
  if (!fake.lotes.some((l) => l.id === `lote-${idHeat}`)) {
    fake.crearLote({
      id: `lote-${idHeat}`, servicioId: "svc-1", fecha, horaInicio: hora, horaFinUltimoHeat: hora,
      horaInicioLimpieza: hora, horaFinLimpieza: hora, cantidadHeats: 1,
    });
    fake.crearHeat({
      id: idHeat, loteId: `lote-${idHeat}`, servicioId: "svc-1", fecha, horaInicio: hora, horaFin: hora, posicionEnLote: 1,
    });
  }
  const { reserva } = fake.crearReservaConAsignacion({
    heatId: idHeat, servicioId: "svc-1", fecha, cantidadParticipantes: 3, estado: "CONFIRMADA",
  });
  Object.assign(reserva, {
    clienteTelefono: datos.telefono,
    clienteNombre: datos.nombre ?? "Nombre Privado",
    estado: datos.estado ?? "CONFIRMADA",
    montoTotal: 21000, montoDeposito: 10500, montoSaldo: 10500,
  });
  return reserva;
}

function escenario() {
  const fake = new FakePrisma();
  fake.crearServicio({ id: "svc-1" });
  return fake;
}

describe("buscarReservasPorTelefonoYFecha", () => {
  it("encuentra la reserva sin importar como se escribio el telefono al reservar o al buscar", async () => {
    const fake = escenario();
    const reserva = crearReserva(fake, "heat-1", "09:00", { telefono: "+506 6068-7547" });

    for (const buscado of ["60687547", "6068-7547", "+506 6068 7547"]) {
      const resultado = await buscarReservasPorTelefonoYFecha(comoPrisma(fake), buscado, FECHA);
      expect(resultado).toHaveLength(1);
      expect(resultado![0]).toMatchObject({
        codigoPublico: reserva.codigoPublico, estado: "CONFIRMADA", fecha: FECHA, cantidadPersonas: 3, montoSaldo: 10500,
      });
      expect(resultado![0]!.lotes[0]!.heats[0]).toMatchObject({ horaInicio: "09:00", personas: 3 });
    }
  });

  it("no devuelve el nombre ni el telefono del cliente", async () => {
    const fake = escenario();
    crearReserva(fake, "heat-1", "09:00", { telefono: "6068-7547", nombre: "Yil Rojas" });

    const resultado = await buscarReservasPorTelefonoYFecha(comoPrisma(fake), "6068-7547", FECHA);

    const texto = JSON.stringify(resultado);
    expect(texto).not.toContain("Yil Rojas");
    expect(texto).not.toContain("60687547");
    expect(texto).not.toContain("6068-7547");
  });

  it("telefono distinto: no devuelve nada (ni siquiera parecido)", async () => {
    const fake = escenario();
    crearReserva(fake, "heat-1", "09:00", { telefono: "6068-7547" });

    expect(await buscarReservasPorTelefonoYFecha(comoPrisma(fake), "6068-7548", FECHA)).toEqual([]);
    expect(await buscarReservasPorTelefonoYFecha(comoPrisma(fake), "6068-754", FECHA)).toBeNull();
  });

  it("fecha distinta: no devuelve nada", async () => {
    const fake = escenario();
    crearReserva(fake, "heat-1", "09:00", { telefono: "6068-7547" });

    expect(await buscarReservasPorTelefonoYFecha(comoPrisma(fake), "6068-7547", "2026-11-22")).toEqual([]);
  });

  it("solo devuelve las del dia buscado cuando el mismo telefono reservo varios dias", async () => {
    const fake = escenario();
    crearReserva(fake, "heat-1", "09:00", { telefono: "6068-7547" });
    crearReserva(fake, "heat-2", "09:00", { telefono: "6068-7547", fecha: OTRA_FECHA_DATE });

    const resultado = await buscarReservasPorTelefonoYFecha(comoPrisma(fake), "6068-7547", FECHA);

    expect(resultado).toHaveLength(1);
    expect(resultado![0]!.fecha).toBe(FECHA);
  });

  it("varias reservas el mismo dia: las devuelve todas ordenadas por hora", async () => {
    const fake = escenario();
    const tarde = crearReserva(fake, "heat-tarde", "14:00", { telefono: "6068-7547" });
    const manana = crearReserva(fake, "heat-manana", "09:00", { telefono: "60687547" });
    crearReserva(fake, "heat-otro", "10:00", { telefono: "8888-8888" });

    const resultado = await buscarReservasPorTelefonoYFecha(comoPrisma(fake), "6068 7547", FECHA);

    expect(resultado!.map((r) => r.codigoPublico)).toEqual([manana.codigoPublico, tarde.codigoPublico]);
  });

  it("incluye reservas canceladas o vencidas con su estado", async () => {
    const fake = escenario();
    crearReserva(fake, "heat-1", "09:00", { telefono: "6068-7547", estado: "CANCELADA" });
    crearReserva(fake, "heat-2", "11:00", { telefono: "6068-7547", estado: "EXPIRADA" });

    const resultado = await buscarReservasPorTelefonoYFecha(comoPrisma(fake), "6068-7547", FECHA);

    expect(resultado!.map((r) => r.estado).sort()).toEqual(["CANCELADA", "EXPIRADA"]);
  });

  it("fecha inexistente en el calendario: invalida (null), sin romper", async () => {
    const fake = escenario();

    expect(await buscarReservasPorTelefonoYFecha(comoPrisma(fake), "6068-7547", "2026-13-45")).toBeNull();
  });
});
