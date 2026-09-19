import { describe, expect, it } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { cancelarReserva, reprogramarReserva } from "./gestion-reservas.service.js";
import { FakePrisma } from "./testing/fake-prisma.js";

// Pruebas de gestion-reservas.service.ts (14.5-14.6) contra FakePrisma, mismo
// doble y mismos fixtures que availability.service.test.ts /
// expiracion.service.test.ts. cancelarReserva reutiliza el motor de
// normalizacion de lotes ya probado alli; reprogramarReserva reutiliza el
// calculo/bloqueo de plan y su persistencia ya probados en
// availability.service.test.ts (confirmarReserva) — aqui se verifica la
// logica NUEVA: transicion de estados validos, retener-antes-de-liberar, y
// que reprogramar hacia el propio horario no se autobloquea (14.6).

function comoPrisma(fake: FakePrisma): PrismaClient {
  return fake as unknown as PrismaClient;
}

const SERVICIO_ID = "svc-1";
const FECHA_ISO = "2026-09-13";
const FECHA_DATE = new Date("2026-09-13T00:00:00.000Z");
const DIA_SEMANA_DOMINGO = 0; // FECHA_DATE.getUTCDay() === 0
const AHORA = new Date("2026-09-13T08:00:00.000Z");

function crearFixtureBase(fake: FakePrisma): void {
  fake.crearServicio({
    id: SERVICIO_ID, moneda: "CRC",
    precioPorPersonaGrupoPequeno: 4000, precioPorPersonaGrupoGrande: 4000, porcentajeDeposito: 50,
  });
  fake.crearPlantilla({
    id: "tpl-1", servicioId: SERVICIO_ID, diaSemana: DIA_SEMANA_DOMINGO,
    horaApertura: "09:00", horaCierre: "16:00", almuerzoInicio: "12:00", almuerzoFin: "12:30", activo: true,
  });
}

describe("cancelarReserva", () => {
  it("cancela una reserva CONFIRMADA, libera su heat y elimina el lote que queda vacio", async () => {
    const fake = new FakePrisma();
    const lote = fake.crearLote({
      id: "lote-1", servicioId: SERVICIO_ID, fecha: FECHA_DATE,
      horaInicio: "10:00", horaFinUltimoHeat: "10:15",
      horaInicioLimpieza: "10:15", horaFinLimpieza: "10:30", cantidadHeats: 1,
    });
    fake.crearHeat({ id: "heat-1", loteId: lote.id, servicioId: SERVICIO_ID, fecha: FECHA_DATE, horaInicio: "10:00", horaFin: "10:15", posicionEnLote: 1 });
    const { reserva } = fake.crearReservaConAsignacion({
      heatId: "heat-1", servicioId: SERVICIO_ID, fecha: FECHA_DATE, cantidadParticipantes: 5, estado: "CONFIRMADA",
    });

    const resultado = await cancelarReserva(comoPrisma(fake), reserva.codigoPublico, AHORA);

    expect(resultado).toEqual({ ok: true });
    expect(fake.reservas.find((r) => r.id === reserva.id)!.estado).toBe("CANCELADA");
    expect(fake.reservas.find((r) => r.id === reserva.id)!.canceladaEn).toEqual(AHORA);
    // El unico heat del lote queda vacio: se elimina junto con el lote y su
    // asignacion (onDelete: Cascade), igual que al vencer una reserva (9.21).
    expect(fake.heats).toHaveLength(0);
    expect(fake.lotes).toHaveLength(0);
    expect(fake.asignaciones).toHaveLength(0);
  });

  it("cancela una reserva TEMPORAL sin heat asignado", async () => {
    const fake = new FakePrisma();
    const { reserva } = fake.crearReservaConAsignacion({
      heatId: "heat-inexistente", servicioId: SERVICIO_ID, fecha: FECHA_DATE, cantidadParticipantes: 2, estado: "TEMPORAL",
    });
    fake.asignaciones.length = 0; // sin asignaciones activas (reserva recien creada, sin heat)

    const resultado = await cancelarReserva(comoPrisma(fake), reserva.codigoPublico, AHORA);

    expect(resultado).toEqual({ ok: true });
    expect(fake.reservas.find((r) => r.id === reserva.id)!.estado).toBe("CANCELADA");
  });

  it("devuelve NO_ENCONTRADA si el codigo no existe", async () => {
    const fake = new FakePrisma();
    expect(await cancelarReserva(comoPrisma(fake), "SRP-NOEXISTE", AHORA)).toEqual({ ok: false, motivo: "NO_ENCONTRADA" });
  });

  it("devuelve ESTADO_INVALIDO si la reserva ya esta cancelada", async () => {
    const fake = new FakePrisma();
    const { reserva } = fake.crearReservaConAsignacion({
      heatId: "heat-x", servicioId: SERVICIO_ID, fecha: FECHA_DATE, cantidadParticipantes: 2, estado: "CONFIRMADA",
    });
    fake.reservas.find((r) => r.id === reserva.id)!.estado = "CANCELADA";

    const resultado = await cancelarReserva(comoPrisma(fake), reserva.codigoPublico, AHORA);

    expect(resultado).toEqual({ ok: false, motivo: "ESTADO_INVALIDO", estadoActual: "CANCELADA" });
  });
});

describe("reprogramarReserva", () => {
  it("reprograma una reserva CONFIRMADA a otro horario: retiene el nuevo plan y libera el anterior", async () => {
    const fake = new FakePrisma();
    crearFixtureBase(fake);
    const lote = fake.crearLote({
      id: "lote-viejo", servicioId: SERVICIO_ID, fecha: FECHA_DATE,
      horaInicio: "10:00", horaFinUltimoHeat: "10:15",
      horaInicioLimpieza: "10:15", horaFinLimpieza: "10:30", cantidadHeats: 1,
    });
    fake.crearHeat({ id: "heat-viejo", loteId: lote.id, servicioId: SERVICIO_ID, fecha: FECHA_DATE, horaInicio: "10:00", horaFin: "10:15", posicionEnLote: 1 });
    const { reserva } = fake.crearReservaConAsignacion({
      heatId: "heat-viejo", servicioId: SERVICIO_ID, fecha: FECHA_DATE, cantidadParticipantes: 5, estado: "CONFIRMADA",
    });

    const resultado = await reprogramarReserva(comoPrisma(fake), reserva.codigoPublico, {
      fecha: FECHA_ISO, horaInicioCandidata: "11:00", cantidadPersonas: 5,
    });

    expect(resultado.ok).toBe(true);
    if (!resultado.ok) return;
    expect("liberacionOperativa" in resultado.plan).toBe(false);

    // Plan anterior liberado: el lote/heat viejo, ya sin asignaciones activas, desaparece.
    expect(fake.heats.find((h) => h.id === "heat-viejo")).toBeUndefined();
    expect(fake.lotes.find((l) => l.id === "lote-viejo")).toBeUndefined();

    // Plan nuevo retenido: una unica asignacion ACTIVA a las 11:00.
    const activas = fake.asignaciones.filter((a) => a.reservationId === reserva.id && a.estado === "ACTIVA");
    expect(activas).toHaveLength(1);
    const heatNuevo = fake.heats.find((h) => h.id === activas[0]!.heatId)!;
    expect(heatNuevo.horaInicio).toBe("11:00");

    expect(fake.reservas.find((r) => r.id === reserva.id)!.cantidadPersonas).toBe(5);
  });

  it("25.8: incrementa vecesReprogramada en cada reprogramacion exitosa", async () => {
    const fake = new FakePrisma();
    crearFixtureBase(fake);
    const lote = fake.crearLote({
      id: "lote-contador", servicioId: SERVICIO_ID, fecha: FECHA_DATE,
      horaInicio: "10:00", horaFinUltimoHeat: "10:15",
      horaInicioLimpieza: "10:15", horaFinLimpieza: "10:30", cantidadHeats: 1,
    });
    fake.crearHeat({ id: "heat-contador", loteId: lote.id, servicioId: SERVICIO_ID, fecha: FECHA_DATE, horaInicio: "10:00", horaFin: "10:15", posicionEnLote: 1 });
    const { reserva } = fake.crearReservaConAsignacion({
      heatId: "heat-contador", servicioId: SERVICIO_ID, fecha: FECHA_DATE, cantidadParticipantes: 2, estado: "CONFIRMADA",
    });
    expect(fake.reservas.find((r) => r.id === reserva.id)!.vecesReprogramada ?? 0).toBe(0);

    const primera = await reprogramarReserva(comoPrisma(fake), reserva.codigoPublico, {
      fecha: FECHA_ISO, horaInicioCandidata: "11:00", cantidadPersonas: 2,
    });
    expect(primera.ok).toBe(true);
    expect(fake.reservas.find((r) => r.id === reserva.id)!.vecesReprogramada).toBe(1);

    // 13:00, no 12:00: la plantilla de horario tiene almuerzo 12:00-12:30.
    const segunda = await reprogramarReserva(comoPrisma(fake), reserva.codigoPublico, {
      fecha: FECHA_ISO, horaInicioCandidata: "13:00", cantidadPersonas: 2,
    });
    expect(segunda.ok).toBe(true);
    expect(fake.reservas.find((r) => r.id === reserva.id)!.vecesReprogramada).toBe(2);
  });

  it("14.6: reprograma hacia su propio horario cambiando solo la cantidad de personas, sin autobloquearse", async () => {
    const fake = new FakePrisma();
    crearFixtureBase(fake);
    const lote = fake.crearLote({
      id: "lote-1", servicioId: SERVICIO_ID, fecha: FECHA_DATE,
      horaInicio: "10:00", horaFinUltimoHeat: "10:15",
      horaInicioLimpieza: "10:15", horaFinLimpieza: "10:30", cantidadHeats: 1,
    });
    fake.crearHeat({ id: "heat-1", loteId: lote.id, servicioId: SERVICIO_ID, fecha: FECHA_DATE, horaInicio: "10:00", horaFin: "10:15", posicionEnLote: 1 });
    const { reserva } = fake.crearReservaConAsignacion({
      heatId: "heat-1", servicioId: SERVICIO_ID, fecha: FECHA_DATE, cantidadParticipantes: 5, estado: "CONFIRMADA", // heat lleno (capacidad 5)
    });

    const resultado = await reprogramarReserva(comoPrisma(fake), reserva.codigoPublico, {
      fecha: FECHA_ISO, horaInicioCandidata: "10:00", cantidadPersonas: 3,
    });

    expect(resultado.ok).toBe(true);
    // Sin la exclusion de la propia reserva, el heat luciria lleno (5/5) y el
    // motor habria creado un heat nuevo en vez de reutilizar heat-1.
    expect(fake.heats).toHaveLength(1);
    expect(fake.heats[0]!.id).toBe("heat-1");
    const activas = fake.asignaciones.filter((a) => a.reservationId === reserva.id && a.estado === "ACTIVA");
    expect(activas).toHaveLength(1);
    expect(activas[0]!.cantidadParticipantes).toBe(3);
    expect(fake.reservas.find((r) => r.id === reserva.id)!.cantidadPersonas).toBe(3);
  });

  it("28: si el deposito ya esta pagado (CONFIRMADA), aumentar personas no toca el deposito, solo el saldo", async () => {
    const fake = new FakePrisma();
    crearFixtureBase(fake);
    const lote = fake.crearLote({
      id: "lote-28a", servicioId: SERVICIO_ID, fecha: FECHA_DATE,
      horaInicio: "10:00", horaFinUltimoHeat: "10:15",
      horaInicioLimpieza: "10:15", horaFinLimpieza: "10:30", cantidadHeats: 1,
    });
    fake.crearHeat({ id: "heat-28a", loteId: lote.id, servicioId: SERVICIO_ID, fecha: FECHA_DATE, horaInicio: "10:00", horaFin: "10:15", posicionEnLote: 1 });
    const { reserva } = fake.crearReservaConAsignacion({
      heatId: "heat-28a", servicioId: SERVICIO_ID, fecha: FECHA_DATE, cantidadParticipantes: 2, estado: "CONFIRMADA",
    });
    // Simula que se aprobo con un monto distinto al 50% de tabla (28: monto
    // real al aprobar SINPE) — el deposito pagado es 6000, no 4000.
    const fila = fake.reservas.find((r) => r.id === reserva.id)!;
    fila.montoTotal = 8000;
    fila.montoDeposito = 6000;
    fila.montoSaldo = 2000;

    const resultado = await reprogramarReserva(comoPrisma(fake), reserva.codigoPublico, {
      fecha: FECHA_ISO, horaInicioCandidata: "10:00", cantidadPersonas: 4,
    });

    expect(resultado.ok).toBe(true);
    const actualizada = fake.reservas.find((r) => r.id === reserva.id)!;
    expect(actualizada.montoTotal).toBe(16000); // 4 personas x 4000
    expect(actualizada.montoDeposito).toBe(6000); // intacto, lo ya pagado
    expect(actualizada.montoSaldo).toBe(10000); // 16000 - 6000
  });

  it("28: si el deposito ya pagado es mayor al nuevo total (reducir personas), el saldo pendiente queda en 0", async () => {
    const fake = new FakePrisma();
    crearFixtureBase(fake);
    const lote = fake.crearLote({
      id: "lote-28b", servicioId: SERVICIO_ID, fecha: FECHA_DATE,
      horaInicio: "10:00", horaFinUltimoHeat: "10:15",
      horaInicioLimpieza: "10:15", horaFinLimpieza: "10:30", cantidadHeats: 1,
    });
    fake.crearHeat({ id: "heat-28b", loteId: lote.id, servicioId: SERVICIO_ID, fecha: FECHA_DATE, horaInicio: "10:00", horaFin: "10:15", posicionEnLote: 1 });
    const { reserva } = fake.crearReservaConAsignacion({
      heatId: "heat-28b", servicioId: SERVICIO_ID, fecha: FECHA_DATE, cantidadParticipantes: 4, estado: "CONFIRMADA",
    });
    const fila = fake.reservas.find((r) => r.id === reserva.id)!;
    fila.montoTotal = 16000;
    fila.montoDeposito = 16000; // pago el 100% del original
    fila.montoSaldo = 0;

    const resultado = await reprogramarReserva(comoPrisma(fake), reserva.codigoPublico, {
      fecha: FECHA_ISO, horaInicioCandidata: "10:00", cantidadPersonas: 2,
    });

    expect(resultado.ok).toBe(true);
    const actualizada = fake.reservas.find((r) => r.id === reserva.id)!;
    expect(actualizada.montoTotal).toBe(8000); // 2 personas x 4000
    expect(actualizada.montoDeposito).toBe(16000); // intacto
    expect(actualizada.montoSaldo).toBe(0); // sin credito, min 0
  });

  it("28: si todavia no hay nada pagado (PENDIENTE_VALIDACION_SINPE), si recalcula el deposito requerido", async () => {
    const fake = new FakePrisma();
    crearFixtureBase(fake);
    const lote = fake.crearLote({
      id: "lote-28c", servicioId: SERVICIO_ID, fecha: FECHA_DATE,
      horaInicio: "10:00", horaFinUltimoHeat: "10:15",
      horaInicioLimpieza: "10:15", horaFinLimpieza: "10:30", cantidadHeats: 1,
    });
    fake.crearHeat({ id: "heat-28c", loteId: lote.id, servicioId: SERVICIO_ID, fecha: FECHA_DATE, horaInicio: "10:00", horaFin: "10:15", posicionEnLote: 1 });
    const { reserva } = fake.crearReservaConAsignacion({
      heatId: "heat-28c", servicioId: SERVICIO_ID, fecha: FECHA_DATE, cantidadParticipantes: 2, estado: "PENDIENTE_VALIDACION_SINPE",
    });

    const resultado = await reprogramarReserva(comoPrisma(fake), reserva.codigoPublico, {
      fecha: FECHA_ISO, horaInicioCandidata: "10:00", cantidadPersonas: 4,
    });

    expect(resultado.ok).toBe(true);
    const actualizada = fake.reservas.find((r) => r.id === reserva.id)!;
    expect(actualizada.montoTotal).toBe(16000);
    expect(actualizada.montoDeposito).toBe(8000); // 50% de tabla, como antes
    expect(actualizada.montoSaldo).toBe(8000);
  });

  it("devuelve NO_ENCONTRADA si el codigo no existe", async () => {
    const fake = new FakePrisma();
    const resultado = await reprogramarReserva(comoPrisma(fake), "SRP-NOEXISTE", {
      fecha: FECHA_ISO, horaInicioCandidata: "10:00", cantidadPersonas: 2,
    });
    expect(resultado).toEqual({ ok: false, motivo: "NO_ENCONTRADA" });
  });

  it("devuelve ESTADO_INVALIDO si la reserva es TEMPORAL (aun no confirmada/pagada)", async () => {
    const fake = new FakePrisma();
    const { reserva } = fake.crearReservaConAsignacion({
      heatId: "heat-x", servicioId: SERVICIO_ID, fecha: FECHA_DATE, cantidadParticipantes: 2, estado: "TEMPORAL",
    });

    const resultado = await reprogramarReserva(comoPrisma(fake), reserva.codigoPublico, {
      fecha: FECHA_ISO, horaInicioCandidata: "10:00", cantidadPersonas: 2,
    });

    expect(resultado).toEqual({ ok: false, motivo: "ESTADO_INVALIDO", estadoActual: "TEMPORAL" });
  });

  it("devuelve NO_DISPONIBLE sin modificar nada si la nueva fecha esta cerrada", async () => {
    const fake = new FakePrisma();
    crearFixtureBase(fake);
    const lote = fake.crearLote({
      id: "lote-1", servicioId: SERVICIO_ID, fecha: FECHA_DATE,
      horaInicio: "10:00", horaFinUltimoHeat: "10:15",
      horaInicioLimpieza: "10:15", horaFinLimpieza: "10:30", cantidadHeats: 1,
    });
    fake.crearHeat({ id: "heat-1", loteId: lote.id, servicioId: SERVICIO_ID, fecha: FECHA_DATE, horaInicio: "10:00", horaFin: "10:15", posicionEnLote: 1 });
    const { reserva } = fake.crearReservaConAsignacion({
      heatId: "heat-1", servicioId: SERVICIO_ID, fecha: FECHA_DATE, cantidadParticipantes: 5, estado: "CONFIRMADA",
    });
    fake.crearExcepcion({ id: "exc-1", servicioId: SERVICIO_ID, fecha: new Date("2026-09-20T00:00:00.000Z"), tipo: "CERRADO" });

    const resultado = await reprogramarReserva(comoPrisma(fake), reserva.codigoPublico, {
      fecha: "2026-09-20", horaInicioCandidata: "10:00", cantidadPersonas: 5,
    });

    expect(resultado.ok).toBe(false);
    if (resultado.ok) return;
    expect(resultado.motivo).toBe("NO_DISPONIBLE");
    // Nada cambio: la asignacion original sigue activa en su heat original.
    expect(fake.heats.find((h) => h.id === "heat-1")).toBeDefined();
    expect(fake.asignaciones.filter((a) => a.reservationId === reserva.id && a.estado === "ACTIVA")).toHaveLength(1);
  });

  it("si otra transaccion gana la carrera por el heat nuevo, reintenta con contexto fresco (8.8.6)", async () => {
    const fake = new FakePrisma();
    crearFixtureBase(fake);
    const lote = fake.crearLote({
      id: "lote-1", servicioId: SERVICIO_ID, fecha: FECHA_DATE,
      horaInicio: "10:00", horaFinUltimoHeat: "10:15",
      horaInicioLimpieza: "10:15", horaFinLimpieza: "10:30", cantidadHeats: 1,
    });
    fake.crearHeat({ id: "heat-1", loteId: lote.id, servicioId: SERVICIO_ID, fecha: FECHA_DATE, horaInicio: "10:00", horaFin: "10:15", posicionEnLote: 1 });
    const { reserva } = fake.crearReservaConAsignacion({
      heatId: "heat-1", servicioId: SERVICIO_ID, fecha: FECHA_DATE, cantidadParticipantes: 5, estado: "CONFIRMADA",
    });
    fake.forzarConflictoUnico("heat", "heats_service_id_fecha_hora_inicio_key", 1);

    const resultado = await reprogramarReserva(comoPrisma(fake), reserva.codigoPublico, {
      fecha: FECHA_ISO, horaInicioCandidata: "11:00", cantidadPersonas: 5,
    });

    expect(resultado.ok).toBe(true);
    expect(fake.asignaciones.filter((a) => a.reservationId === reserva.id && a.estado === "ACTIVA")).toHaveLength(1);
  });
});
