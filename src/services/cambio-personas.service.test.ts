import { describe, expect, it } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { aplicarCambioPersonas, consultarOpcionesCambioPersonas } from "./cambio-personas.service.js";
import { FakePrisma, type FilaReserva } from "./testing/fake-prisma.js";

// Cambio de cantidad de personas por el administrador, por encima del limite
// de 5 por heat (excepcion operativa): "mismo slot" (sin tope, aunque el heat
// lo comparta con otra reserva) o "repartir equitativamente" (rearma la
// reserva desde su hora original; solo si no choca con otras reservas).

function comoPrisma(fake: FakePrisma): PrismaClient {
  return fake as unknown as PrismaClient;
}

const SERVICIO_ID = "svc-1";
const FECHA_DATE = new Date("2026-09-13T00:00:00.000Z");
const DIA_SEMANA_DOMINGO = 0;

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

function sumar15(hora: string): string {
  const [h, m] = hora.split(":").map(Number);
  const total = h! * 60 + m! + 15;
  return `${String(Math.floor(total / 60)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
}

/** Lote con heats consecutivos (cada uno de 15 min) mas su limpieza. */
function crearLoteConHeats(fake: FakePrisma, loteId: string, horas: readonly string[]): string[] {
  const ultimoFin = sumar15(horas[horas.length - 1]!);
  fake.crearLote({
    id: loteId, servicioId: SERVICIO_ID, fecha: FECHA_DATE,
    horaInicio: horas[0]!, horaFinUltimoHeat: ultimoFin,
    horaInicioLimpieza: ultimoFin, horaFinLimpieza: sumar15(ultimoFin), cantidadHeats: horas.length,
  });
  return horas.map((hora, i) => {
    const id = `${loteId}-heat-${i + 1}`;
    fake.crearHeat({
      id, loteId, servicioId: SERVICIO_ID, fecha: FECHA_DATE,
      horaInicio: hora, horaFin: sumar15(hora), posicionEnLote: i + 1,
    });
    return id;
  });
}

/** Reserva con una asignacion por heat (personas por heat en `personas`).
 * Por defecto cobrada a 4000 por persona con el 50% de deposito ya pagado. */
function crearReserva(
  fake: FakePrisma,
  heatIds: readonly string[],
  personas: readonly number[],
  extra: Partial<FilaReserva> = {},
): FilaReserva {
  const total = personas.reduce((a, b) => a + b, 0);
  const { reserva } = fake.crearReservaConAsignacion({
    heatId: heatIds[0]!, servicioId: SERVICIO_ID, fecha: FECHA_DATE, cantidadParticipantes: personas[0]!, estado: "CONFIRMADA",
  });
  for (let i = 1; i < heatIds.length; i++) {
    fake.asignaciones.push({
      id: `${reserva.id}-extra-${i}`, reservationId: reserva.id, heatId: heatIds[i]!,
      cantidadParticipantes: personas[i]!, estado: "ACTIVA",
    });
  }
  const precio = total * 4000;
  Object.assign(reserva, {
    cantidadPersonas: total,
    montoTotal: precio, montoDeposito: precio / 2, montoSaldo: precio / 2,
    ...extra,
  });
  return reserva;
}

function activasOrdenadas(fake: FakePrisma, reservationId: string) {
  return fake.asignaciones
    .filter((a) => a.reservationId === reservationId && a.estado === "ACTIVA")
    .map((a) => ({ hora: fake.heats.find((h) => h.id === a.heatId)!.horaInicio, personas: a.cantidadParticipantes }))
    .sort((a, b) => a.hora.localeCompare(b.hora));
}

describe("consultarOpcionesCambioPersonas", () => {
  it("Laura: 5 -> 8 en un heat solo: pide decision; mismo slot = 8 juntos; repartir = 4 + 4 seguidos", async () => {
    const fake = new FakePrisma();
    crearFixtureBase(fake);
    const [heat] = crearLoteConHeats(fake, "lote-1", ["09:00"]);
    const reserva = crearReserva(fake, [heat!], [5]);

    const r = await consultarOpcionesCambioPersonas(comoPrisma(fake), reserva.codigoPublico, 8);

    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.requiereDecision).toBe(true);
    expect(r.mismoSlot).toEqual([{ horaInicio: "09:00", horaFin: "09:15", personas: 8 }]);
    expect(r.repartir).toEqual({
      disponible: true,
      heats: [
        { horaInicio: "09:00", horaFin: "09:15", personas: 4 },
        { horaInicio: "09:15", horaFin: "09:30", personas: 4 },
      ],
    });
    expect(r.montoTotal).toBe(32000);
    expect(r.montoSaldo).toBe(22000); // 32000 - deposito ya pagado de 10000
    expect(fake.asignaciones.filter((a) => a.estado === "ACTIVA")).toHaveLength(1); // solo consulta, no cambia nada
  });

  it("si la reserva sigue cabiendo en sus heats (<= 5 por heat), no pide decision", async () => {
    const fake = new FakePrisma();
    crearFixtureBase(fake);
    const [heat] = crearLoteConHeats(fake, "lote-1", ["10:00"]);
    const reserva = crearReserva(fake, [heat!], [3]);

    const r = await consultarOpcionesCambioPersonas(comoPrisma(fake), reserva.codigoPublico, 5);

    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.requiereDecision).toBe(false);
    expect(r.repartir).toBeNull();
  });

  it("si el heat lo comparte otra reserva y el total pasaria de 5, pide decision", async () => {
    const fake = new FakePrisma();
    crearFixtureBase(fake);
    const [heat] = crearLoteConHeats(fake, "lote-1", ["10:00"]);
    const reserva = crearReserva(fake, [heat!], [2]);
    crearReserva(fake, [heat!], [3]); // otra reserva en el mismo heat: 2 + 3 = 5 (lleno)

    const r = await consultarOpcionesCambioPersonas(comoPrisma(fake), reserva.codigoPublico, 4);

    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.requiereDecision).toBe(true);
  });

  it("Pedro con choque: si repartir toparia con otra reserva, repartir no esta disponible y mismo slot si", async () => {
    const fake = new FakePrisma();
    crearFixtureBase(fake);
    const [heatPedro] = crearLoteConHeats(fake, "lote-pedro", ["10:00"]);
    const reserva = crearReserva(fake, [heatPedro!], [4]);
    // Otro lote empieza justo despues de la limpieza de Pedro (10:30): no hay
    // lugar para ampliar el suyo con un segundo heat y su nueva limpieza.
    const [heatOtro] = crearLoteConHeats(fake, "lote-otro", ["10:30"]);
    crearReserva(fake, [heatOtro!], [5]);

    const r = await consultarOpcionesCambioPersonas(comoPrisma(fake), reserva.codigoPublico, 10);

    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.requiereDecision).toBe(true);
    expect(r.repartir).toEqual({ disponible: false, motivo: "CHOCA_CON_OTRAS_RESERVAS" });
    expect(r.mismoSlot).toEqual([{ horaInicio: "10:00", horaFin: "10:15", personas: 10 }]);
  });

  it("valida: reserva inexistente, estado no modificable y cantidad que no sube", async () => {
    const fake = new FakePrisma();
    crearFixtureBase(fake);
    const [heat] = crearLoteConHeats(fake, "lote-1", ["10:00"]);
    const reserva = crearReserva(fake, [heat!], [4]);
    const pagada = crearReserva(fake, [heat!], [1], { estado: "PAGADA" });

    expect(await consultarOpcionesCambioPersonas(comoPrisma(fake), "SRP-NO-EXISTE", 6)).toEqual({ ok: false, motivo: "NO_ENCONTRADA" });
    expect(await consultarOpcionesCambioPersonas(comoPrisma(fake), pagada.codigoPublico, 6)).toEqual({ ok: false, motivo: "ESTADO_INVALIDO" });
    expect(await consultarOpcionesCambioPersonas(comoPrisma(fake), reserva.codigoPublico, 4)).toEqual({ ok: false, motivo: "CANTIDAD_INVALIDA" });
    expect(await consultarOpcionesCambioPersonas(comoPrisma(fake), reserva.codigoPublico, 3)).toEqual({ ok: false, motivo: "CANTIDAD_INVALIDA" });
    expect(await consultarOpcionesCambioPersonas(comoPrisma(fake), reserva.codigoPublico, 5.5)).toEqual({ ok: false, motivo: "CANTIDAD_INVALIDA" });
  });
});

describe("aplicarCambioPersonas", () => {
  it("Laura, mismo slot: quedan 8 en el heat de las 9, el deposito pagado no cambia y el saldo se actualiza", async () => {
    const fake = new FakePrisma();
    crearFixtureBase(fake);
    const [heat] = crearLoteConHeats(fake, "lote-1", ["09:00"]);
    const reserva = crearReserva(fake, [heat!], [5]);

    const r = await aplicarCambioPersonas(comoPrisma(fake), reserva.codigoPublico, 8, "MISMO_SLOT");

    expect(r).toEqual({ ok: true, modo: "MISMO_SLOT", montoTotal: 32000, montoSaldo: 22000 });
    expect(activasOrdenadas(fake, reserva.id)).toEqual([{ hora: "09:00", personas: 8 }]);
    expect(fake.heats).toHaveLength(1);
    const actual = fake.reservas.find((x) => x.id === reserva.id)!;
    expect(actual.cantidadPersonas).toBe(8);
    expect(actual.montoTotal).toBe(32000);
    expect(actual.montoDeposito).toBe(10000);
    expect(actual.montoSaldo).toBe(22000);
    expect(actual.vecesReprogramada ?? 0).toBe(0); // no es una reprogramacion
  });

  it("sin elegir modo cuando hace falta decidir: DECISION_REQUERIDA y no cambia nada", async () => {
    const fake = new FakePrisma();
    crearFixtureBase(fake);
    const [heat] = crearLoteConHeats(fake, "lote-1", ["09:00"]);
    const reserva = crearReserva(fake, [heat!], [5]);

    const r = await aplicarCambioPersonas(comoPrisma(fake), reserva.codigoPublico, 8);

    expect(r).toEqual({ ok: false, motivo: "DECISION_REQUERIDA" });
    expect(activasOrdenadas(fake, reserva.id)).toEqual([{ hora: "09:00", personas: 5 }]);
    expect(fake.reservas.find((x) => x.id === reserva.id)!.cantidadPersonas).toBe(5);
  });

  it("sin necesidad de decidir (cabe en sus heats) se aplica directo", async () => {
    const fake = new FakePrisma();
    crearFixtureBase(fake);
    const [heat] = crearLoteConHeats(fake, "lote-1", ["10:00"]);
    const reserva = crearReserva(fake, [heat!], [3]);

    const r = await aplicarCambioPersonas(comoPrisma(fake), reserva.codigoPublico, 5);

    expect(r.ok).toBe(true);
    expect(activasOrdenadas(fake, reserva.id)).toEqual([{ hora: "10:00", personas: 5 }]);
  });

  it("Pedro, repartir: 4 -> 10 queda 5 + 5 en dos heats seguidos desde la hora original", async () => {
    const fake = new FakePrisma();
    crearFixtureBase(fake);
    const [heat] = crearLoteConHeats(fake, "lote-1", ["10:00"]);
    const reserva = crearReserva(fake, [heat!], [4]);

    const r = await aplicarCambioPersonas(comoPrisma(fake), reserva.codigoPublico, 10, "REPARTIR");

    expect(r).toEqual({ ok: true, modo: "REPARTIR", montoTotal: 40000, montoSaldo: 32000 });
    expect(activasOrdenadas(fake, reserva.id)).toEqual([
      { hora: "10:00", personas: 5 },
      { hora: "10:15", personas: 5 },
    ]);
    // Las asignaciones anteriores quedan liberadas, no duplicadas.
    expect(fake.asignaciones.filter((a) => a.reservationId === reserva.id && a.estado === "LIBERADA")).toHaveLength(1);
    const actual = fake.reservas.find((x) => x.id === reserva.id)!;
    expect(actual.cantidadPersonas).toBe(10);
    expect(actual.montoDeposito).toBe(8000);
    expect(actual.montoSaldo).toBe(32000);
  });

  it("repartir con choque: REPARTO_NO_DISPONIBLE y la reserva queda intacta", async () => {
    const fake = new FakePrisma();
    crearFixtureBase(fake);
    const [heatPedro] = crearLoteConHeats(fake, "lote-pedro", ["10:00"]);
    const reserva = crearReserva(fake, [heatPedro!], [4]);
    const [heatOtro] = crearLoteConHeats(fake, "lote-otro", ["10:30"]);
    crearReserva(fake, [heatOtro!], [5]);

    const r = await aplicarCambioPersonas(comoPrisma(fake), reserva.codigoPublico, 10, "REPARTIR");

    expect(r).toEqual({ ok: false, motivo: "REPARTO_NO_DISPONIBLE" });
    expect(activasOrdenadas(fake, reserva.id)).toEqual([{ hora: "10:00", personas: 4 }]);
    expect(fake.reservas.find((x) => x.id === reserva.id)!.cantidadPersonas).toBe(4);
  });

  it("mismo slot compartido con otra reserva: se permite pasar de 5 en total", async () => {
    const fake = new FakePrisma();
    crearFixtureBase(fake);
    const [heat] = crearLoteConHeats(fake, "lote-1", ["10:00"]);
    const reserva = crearReserva(fake, [heat!], [2]);
    const otra = crearReserva(fake, [heat!], [3]);

    const r = await aplicarCambioPersonas(comoPrisma(fake), reserva.codigoPublico, 4, "MISMO_SLOT");

    expect(r.ok).toBe(true);
    expect(activasOrdenadas(fake, reserva.id)).toEqual([{ hora: "10:00", personas: 4 }]);
    expect(activasOrdenadas(fake, otra.id)).toEqual([{ hora: "10:00", personas: 3 }]); // la otra no se toca
  });

  it("reserva con varios heats (3 + 3): mismo slot reparte el total nuevo entre los heats que ya tiene", async () => {
    const fake = new FakePrisma();
    crearFixtureBase(fake);
    const heats = crearLoteConHeats(fake, "lote-1", ["10:00", "10:15"]);
    const reserva = crearReserva(fake, heats, [3, 3]);

    const r = await aplicarCambioPersonas(comoPrisma(fake), reserva.codigoPublico, 9); // [5,4]: cabe, sin decision

    expect(r).toEqual({ ok: true, modo: "MISMO_SLOT", montoTotal: 36000, montoSaldo: 24000 });
    expect(activasOrdenadas(fake, reserva.id)).toEqual([
      { hora: "10:00", personas: 5 },
      { hora: "10:15", personas: 4 },
    ]);
  });

  describe("reserva de 2 heats (repeticiones)", () => {
    function crearReservaDeDosHeats(fake: FakePrisma) {
      const heats = crearLoteConHeats(fake, "lote-1", ["10:00", "10:15"]);
      // 5 personas corren 2 vueltas seguidas: precio de 2 vueltas (2 x 20000).
      return crearReserva(fake, heats, [5, 5], {
        repeticiones: 2, cantidadPersonas: 5, montoTotal: 40000, montoDeposito: 20000, montoSaldo: 20000,
      });
    }

    it("mismo slot: los 8 corren las 2 vueltas y se cobra el precio de 2 vueltas", async () => {
      const fake = new FakePrisma();
      crearFixtureBase(fake);
      const reserva = crearReservaDeDosHeats(fake);

      const r = await aplicarCambioPersonas(comoPrisma(fake), reserva.codigoPublico, 8, "MISMO_SLOT");

      expect(r).toEqual({ ok: true, modo: "MISMO_SLOT", montoTotal: 64000, montoSaldo: 44000 });
      expect(activasOrdenadas(fake, reserva.id)).toEqual([
        { hora: "10:00", personas: 8 },
        { hora: "10:15", personas: 8 },
      ]);
    });

    it("repartir: cada vuelta se divide por separado (4 + 4 y 4 + 4, seguidos)", async () => {
      const fake = new FakePrisma();
      crearFixtureBase(fake);
      const reserva = crearReservaDeDosHeats(fake);

      const r = await aplicarCambioPersonas(comoPrisma(fake), reserva.codigoPublico, 8, "REPARTIR");

      expect(r).toEqual({ ok: true, modo: "REPARTIR", montoTotal: 64000, montoSaldo: 44000 });
      expect(activasOrdenadas(fake, reserva.id)).toEqual([
        { hora: "10:00", personas: 4 },
        { hora: "10:15", personas: 4 },
        { hora: "10:30", personas: 4 },
        { hora: "10:45", personas: 4 },
      ]);
    });
  });

  it("si el deposito todavia no esta aprobado (SINPE pendiente), se recalcula el 50% del total nuevo", async () => {
    const fake = new FakePrisma();
    crearFixtureBase(fake);
    const [heat] = crearLoteConHeats(fake, "lote-1", ["10:00"]);
    const reserva = crearReserva(fake, [heat!], [5], { estado: "PENDIENTE_VALIDACION_SINPE" });

    await aplicarCambioPersonas(comoPrisma(fake), reserva.codigoPublico, 8, "MISMO_SLOT");

    const actual = fake.reservas.find((x) => x.id === reserva.id)!;
    expect(actual.montoTotal).toBe(32000);
    expect(actual.montoDeposito).toBe(16000);
    expect(actual.montoSaldo).toBe(16000);
  });

  it("valida estado y cantidad igual que la consulta", async () => {
    const fake = new FakePrisma();
    crearFixtureBase(fake);
    const [heat] = crearLoteConHeats(fake, "lote-1", ["10:00"]);
    const reserva = crearReserva(fake, [heat!], [4]);
    const pagada = crearReserva(fake, [heat!], [1], { estado: "PAGADA" });

    expect(await aplicarCambioPersonas(comoPrisma(fake), "SRP-NO-EXISTE", 6, "MISMO_SLOT")).toEqual({ ok: false, motivo: "NO_ENCONTRADA" });
    expect(await aplicarCambioPersonas(comoPrisma(fake), pagada.codigoPublico, 6, "MISMO_SLOT")).toEqual({ ok: false, motivo: "ESTADO_INVALIDO" });
    expect(await aplicarCambioPersonas(comoPrisma(fake), reserva.codigoPublico, 4, "MISMO_SLOT")).toEqual({ ok: false, motivo: "CANTIDAD_INVALIDA" });
  });
});
