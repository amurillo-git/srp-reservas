import { describe, expect, it } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { expirarReservasVencidas, expirarUnaReserva } from "./expiracion.service.js";
import { FakePrisma } from "./testing/fake-prisma.js";

// Pruebas del servicio de expiracion (11.2, 19.1, 6.7.6-8) contra el mismo
// doble en memoria FakePrisma usado por availability.service.test.ts. Cada
// escenario corresponde a una combinacion de "que heats quedan vacios tras
// liberar" ya cubierta a nivel de motor puro en
// motor-disponibilidad.test.ts (describe "normalizarLoteTrasLiberacion");
// aqui se verifica que el servicio realmente aplica ese resultado sobre la
// base de datos (crea/borra/actualiza las filas correctas).

function comoPrisma(fake: FakePrisma): PrismaClient {
  return fake as unknown as PrismaClient;
}

const SERVICIO_ID = "svc-1";
const FECHA_DATE = new Date("2026-09-13T00:00:00.000Z");
const AHORA = new Date("2026-09-13T14:00:00.000Z");
const HACE_UN_RATO = new Date(AHORA.getTime() - 60_000);
const EN_UN_RATO = new Date(AHORA.getTime() + 60_000);

describe("expirarUnaReserva", () => {
  it("9.20: si el heat conserva otras asignaciones, solo se libera la propia; el lote no cambia", async () => {
    const fake = new FakePrisma();
    const lote = fake.crearLote({
      id: "lote-1", servicioId: SERVICIO_ID, fecha: FECHA_DATE,
      horaInicio: "14:00", horaFinUltimoHeat: "14:15",
      horaInicioLimpieza: "14:15", horaFinLimpieza: "14:30", cantidadHeats: 1,
    });
    fake.crearHeat({
      id: "heat-1", loteId: lote.id, servicioId: SERVICIO_ID, fecha: FECHA_DATE,
      horaInicio: "14:00", horaFin: "14:15", posicionEnLote: 1,
    });
    fake.crearReservaConAsignacion({
      heatId: "heat-1", servicioId: SERVICIO_ID, fecha: FECHA_DATE,
      cantidadParticipantes: 2, estado: "CONFIRMADA",
    });
    const { reserva: reservaVencida, asignacion } = fake.crearReservaConAsignacion({
      heatId: "heat-1", servicioId: SERVICIO_ID, fecha: FECHA_DATE,
      cantidadParticipantes: 3, estado: "TEMPORAL", expiraEn: HACE_UN_RATO,
    });

    const resultado = await expirarUnaReserva(comoPrisma(fake), reservaVencida.id, AHORA);

    expect(resultado).toEqual({ reservationId: reservaVencida.id, expirada: true });
    expect(fake.reservas.find((r) => r.id === reservaVencida.id)!.estado).toBe("EXPIRADA");
    const asignacionActualizada = fake.asignaciones.find((a) => a.id === asignacion.id)!;
    expect(asignacionActualizada.estado).toBe("LIBERADA");
    expect(asignacionActualizada.liberadoEn).toEqual(AHORA);
    // El heat y el lote siguen existiendo, sin cambios: la reserva confirmada permanece.
    expect(fake.heats).toHaveLength(1);
    expect(fake.lotes[0]).toMatchObject({ horaInicio: "14:00", cantidadHeats: 1 });
  });

  it("9.21: si el lote entero queda vacio, se elimina junto con sus heats y asignaciones", async () => {
    const fake = new FakePrisma();
    const lote = fake.crearLote({
      id: "lote-1", servicioId: SERVICIO_ID, fecha: FECHA_DATE,
      horaInicio: "14:30", horaFinUltimoHeat: "15:00",
      horaInicioLimpieza: "15:00", horaFinLimpieza: "15:15", cantidadHeats: 2,
    });
    fake.crearHeat({
      id: "heat-1", loteId: lote.id, servicioId: SERVICIO_ID, fecha: FECHA_DATE,
      horaInicio: "14:30", horaFin: "14:45", posicionEnLote: 1,
    });
    fake.crearHeat({
      id: "heat-2", loteId: lote.id, servicioId: SERVICIO_ID, fecha: FECHA_DATE,
      horaInicio: "14:45", horaFin: "15:00", posicionEnLote: 2,
    });
    fake.reservas.push({
      id: "res-7p", codigoPublico: "SRP-7P", servicioId: SERVICIO_ID, fecha: FECHA_DATE,
      cantidadPersonas: 7, estado: "TEMPORAL", moneda: "CRC", montoTotal: 0, montoDeposito: 0, montoSaldo: 0,
      claveIdempotencia: "idem-7p", clienteNombre: "Grupo", clienteTelefono: "00000000",
      expiraEn: HACE_UN_RATO,
    });
    fake.asignaciones.push(
      { id: "alloc-7p-1", reservationId: "res-7p", heatId: "heat-1", cantidadParticipantes: 4, estado: "ACTIVA" },
      { id: "alloc-7p-2", reservationId: "res-7p", heatId: "heat-2", cantidadParticipantes: 3, estado: "ACTIVA" },
    );

    const resultado = await expirarUnaReserva(comoPrisma(fake), "res-7p", AHORA);

    expect(resultado).toEqual({ reservationId: "res-7p", expirada: true });
    expect(fake.reservas.find((r) => r.id === "res-7p")!.estado).toBe("EXPIRADA");
    expect(fake.heats).toHaveLength(0);
    expect(fake.lotes).toHaveLength(0);
    expect(fake.asignaciones).toHaveLength(0);
  });

  it("6.7.8: un heat que queda vacio en medio de dos ocupados permanece como parte del lote", async () => {
    const fake = new FakePrisma();
    const lote = fake.crearLote({
      id: "lote-1", servicioId: SERVICIO_ID, fecha: FECHA_DATE,
      horaInicio: "10:00", horaFinUltimoHeat: "10:45",
      horaInicioLimpieza: "10:45", horaFinLimpieza: "11:00", cantidadHeats: 3,
    });
    fake.crearHeat({ id: "heat-1", loteId: lote.id, servicioId: SERVICIO_ID, fecha: FECHA_DATE, horaInicio: "10:00", horaFin: "10:15", posicionEnLote: 1 });
    fake.crearHeat({ id: "heat-2", loteId: lote.id, servicioId: SERVICIO_ID, fecha: FECHA_DATE, horaInicio: "10:15", horaFin: "10:30", posicionEnLote: 2 });
    fake.crearHeat({ id: "heat-3", loteId: lote.id, servicioId: SERVICIO_ID, fecha: FECHA_DATE, horaInicio: "10:30", horaFin: "10:45", posicionEnLote: 3 });
    fake.crearReservaConAsignacion({ heatId: "heat-1", servicioId: SERVICIO_ID, fecha: FECHA_DATE, cantidadParticipantes: 5, estado: "CONFIRMADA" });
    const { reserva: reservaVencida } = fake.crearReservaConAsignacion({
      heatId: "heat-2", servicioId: SERVICIO_ID, fecha: FECHA_DATE,
      cantidadParticipantes: 5, estado: "TEMPORAL", expiraEn: HACE_UN_RATO,
    });
    fake.crearReservaConAsignacion({ heatId: "heat-3", servicioId: SERVICIO_ID, fecha: FECHA_DATE, cantidadParticipantes: 5, estado: "CONFIRMADA" });

    await expirarUnaReserva(comoPrisma(fake), reservaVencida.id, AHORA);

    expect(fake.heats).toHaveLength(3); // ninguno se elimino
    expect(fake.lotes[0]).toMatchObject({ horaInicio: "10:00", horaFinUltimoHeat: "10:45", cantidadHeats: 3 });
    expect(fake.heats.find((h) => h.id === "heat-2")!.posicionEnLote).toBe(2); // sin renumerar
  });

  it("6.7.8: recorta el heat vacio del inicio del lote sin mover la limpieza", async () => {
    const fake = new FakePrisma();
    const lote = fake.crearLote({
      id: "lote-1", servicioId: SERVICIO_ID, fecha: FECHA_DATE,
      horaInicio: "10:00", horaFinUltimoHeat: "10:30",
      horaInicioLimpieza: "10:30", horaFinLimpieza: "10:45", cantidadHeats: 2,
    });
    fake.crearHeat({ id: "heat-1", loteId: lote.id, servicioId: SERVICIO_ID, fecha: FECHA_DATE, horaInicio: "10:00", horaFin: "10:15", posicionEnLote: 1 });
    fake.crearHeat({ id: "heat-2", loteId: lote.id, servicioId: SERVICIO_ID, fecha: FECHA_DATE, horaInicio: "10:15", horaFin: "10:30", posicionEnLote: 2 });
    const { reserva: reservaVencida } = fake.crearReservaConAsignacion({
      heatId: "heat-1", servicioId: SERVICIO_ID, fecha: FECHA_DATE,
      cantidadParticipantes: 5, estado: "TEMPORAL", expiraEn: HACE_UN_RATO,
    });
    fake.crearReservaConAsignacion({ heatId: "heat-2", servicioId: SERVICIO_ID, fecha: FECHA_DATE, cantidadParticipantes: 5, estado: "CONFIRMADA" });

    await expirarUnaReserva(comoPrisma(fake), reservaVencida.id, AHORA);

    expect(fake.heats).toHaveLength(1);
    const heatRestante = fake.heats[0]!;
    expect(heatRestante.id).toBe("heat-2");
    expect(heatRestante.posicionEnLote).toBe(1); // renumerado
    expect(fake.lotes[0]).toMatchObject({
      horaInicio: "10:15", // se movio al nuevo primer heat
      horaFinUltimoHeat: "10:30", // sin cambio: el ultimo heat no se toco
      horaInicioLimpieza: "10:30",
      horaFinLimpieza: "10:45",
      cantidadHeats: 1,
    });
  });

  it("si bajo lock la reserva ya no califica (por ejemplo ya fue confirmada), no hace nada", async () => {
    const fake = new FakePrisma();
    const { reserva } = fake.crearReservaConAsignacion({
      heatId: "heat-inexistente", servicioId: SERVICIO_ID, fecha: FECHA_DATE,
      cantidadParticipantes: 2, estado: "CONFIRMADA", // ya no es TEMPORAL
    });

    const resultado = await expirarUnaReserva(comoPrisma(fake), reserva.id, AHORA);

    expect(resultado).toEqual({ reservationId: reserva.id, expirada: false });
    expect(fake.reservas.find((r) => r.id === reserva.id)!.estado).toBe("CONFIRMADA");
  });
});

describe("expirarReservasVencidas", () => {
  it("procesa solo las reservas TEMPORAL cuyo plazo ya paso, dejando las demas intactas", async () => {
    const fake = new FakePrisma();
    const lote = fake.crearLote({
      id: "lote-1", servicioId: SERVICIO_ID, fecha: FECHA_DATE,
      horaInicio: "09:00", horaFinUltimoHeat: "09:15",
      horaInicioLimpieza: "09:15", horaFinLimpieza: "09:30", cantidadHeats: 1,
    });
    fake.crearHeat({ id: "heat-1", loteId: lote.id, servicioId: SERVICIO_ID, fecha: FECHA_DATE, horaInicio: "09:00", horaFin: "09:15", posicionEnLote: 1 });

    const { reserva: vencida } = fake.crearReservaConAsignacion({
      heatId: "heat-1", servicioId: SERVICIO_ID, fecha: FECHA_DATE,
      cantidadParticipantes: 5, estado: "TEMPORAL", expiraEn: HACE_UN_RATO,
    });
    const { reserva: vigente } = fake.crearReservaConAsignacion({
      heatId: "heat-1", servicioId: SERVICIO_ID, fecha: FECHA_DATE,
      cantidadParticipantes: 0, estado: "TEMPORAL", expiraEn: EN_UN_RATO,
    });
    const { reserva: confirmada } = fake.crearReservaConAsignacion({
      heatId: "heat-1", servicioId: SERVICIO_ID, fecha: FECHA_DATE,
      cantidadParticipantes: 0, estado: "CONFIRMADA",
    });
    // 6.9.5: pendiente de validacion SINPE, aunque su expiraEn (heredado de
    // cuando era TEMPORAL) ya haya pasado, NO debe expirar por el timer.
    const { reserva: pendienteSinpe } = fake.crearReservaConAsignacion({
      heatId: "heat-1", servicioId: SERVICIO_ID, fecha: FECHA_DATE,
      cantidadParticipantes: 0, estado: "PENDIENTE_VALIDACION_SINPE", expiraEn: HACE_UN_RATO,
    });

    const resultados = await expirarReservasVencidas(comoPrisma(fake), AHORA);

    expect(resultados).toEqual([{ reservationId: vencida.id, expirada: true }]);
    expect(fake.reservas.find((r) => r.id === vencida.id)!.estado).toBe("EXPIRADA");
    expect(fake.reservas.find((r) => r.id === vigente.id)!.estado).toBe("TEMPORAL");
    expect(fake.reservas.find((r) => r.id === confirmada.id)!.estado).toBe("CONFIRMADA");
    expect(fake.reservas.find((r) => r.id === pendienteSinpe.id)!.estado).toBe("PENDIENTE_VALIDACION_SINPE");
  });
});
