import { describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { confirmarReserva, consultarDisponibilidad, consultarDisponibilidadDelDia } from "./availability.service.js";
import { FakePrisma } from "./testing/fake-prisma.js";

// Pruebas unitarias de availability.service.ts contra el doble en memoria
// FakePrisma (ver src/services/testing/fake-prisma.ts). Cubren la logica de
// control que SI se puede probar sin Postgres real: clasificacion de
// bloques del calendario (construirContextoDisponibilidad), capacidad
// compartida (6.5), ocultamiento de la limpieza (8.7), idempotencia (8.8.7)
// y la logica de reintento ante un conflicto de unicidad (8.8.6). Las
// garantias de concurrencia real (CONC-001) viven aparte, en
// availability.service.integration.test.ts, contra Postgres real.

function comoPrisma(fake: FakePrisma): PrismaClient {
  return fake as unknown as PrismaClient;
}

const SERVICIO_ID = "svc-1";
const FECHA_ISO = "2026-09-13";
const FECHA_DATE = new Date("2026-09-13T00:00:00.000Z");
const DIA_SEMANA_DOMINGO = 0; // FECHA_DATE.getUTCDay() === 0

/** Servicio con tarifa + plantilla habitual de domingo (9:00-16:00, almuerzo
 * 12:00-12:30), sin excepciones ni bloqueos: equivalente al "dia vacio" del
 * motor puro, pero reconstruido desde Prisma. */
function crearFixtureBase(fake: FakePrisma): void {
  fake.crearServicio({ id: SERVICIO_ID, moneda: "CRC", precioPorPersona: 4000, porcentajeDeposito: 50 });
  fake.crearPlantilla({
    id: "tpl-1",
    servicioId: SERVICIO_ID,
    diaSemana: DIA_SEMANA_DOMINGO,
    horaApertura: "09:00",
    horaCierre: "16:00",
    almuerzoInicio: "12:00",
    almuerzoFin: "12:30",
    activo: true,
  });
}

describe("consultarDisponibilidad", () => {
  it("una excepcion CERRADO cierra la fecha por completo aunque la plantilla la abriria (6.2)", async () => {
    const fake = new FakePrisma();
    crearFixtureBase(fake);
    fake.crearExcepcion({ id: "exc-1", servicioId: SERVICIO_ID, fecha: FECHA_DATE, tipo: "CERRADO" });

    const resultado = await consultarDisponibilidad(comoPrisma(fake), {
      servicioId: SERVICIO_ID,
      fecha: FECHA_ISO,
      horaInicioCandidata: "09:00",
      cantidadPersonas: 5,
    });

    expect(resultado.disponible).toBe(false);
  });

  it("una plantilla inactiva sin excepcion deja la fecha cerrada (6.2)", async () => {
    const fake = new FakePrisma();
    fake.crearServicio({ id: SERVICIO_ID });
    fake.crearPlantilla({
      id: "tpl-1",
      servicioId: SERVICIO_ID,
      diaSemana: DIA_SEMANA_DOMINGO,
      activo: false,
    });

    const resultado = await consultarDisponibilidad(comoPrisma(fake), {
      servicioId: SERVICIO_ID,
      fecha: FECHA_ISO,
      horaInicioCandidata: "09:00",
      cantidadPersonas: 5,
    });

    expect(resultado.disponible).toBe(false);
  });

  it("una excepcion HABILITADO abre la fecha aunque no exista plantilla para ese dia (6.2, feriado)", async () => {
    const fake = new FakePrisma();
    fake.crearServicio({ id: SERVICIO_ID });
    fake.crearExcepcion({
      id: "exc-1",
      servicioId: SERVICIO_ID,
      fecha: FECHA_DATE,
      tipo: "HABILITADO",
      horaApertura: "09:00",
      horaCierre: "16:00",
      almuerzoInicio: "12:00",
      almuerzoFin: "12:30",
    });

    const resultado = await consultarDisponibilidad(comoPrisma(fake), {
      servicioId: SERVICIO_ID,
      fecha: FECHA_ISO,
      horaInicioCandidata: "09:00",
      cantidadPersonas: 5,
    });

    expect(resultado.disponible).toBe(true);
  });

  it("la capacidad ocupada cuenta confirmadas, temporales vigentes y SINPE pendientes; ignora temporales vencidas (6.5)", async () => {
    const fake = new FakePrisma();
    crearFixtureBase(fake);
    const lote = fake.crearLote({
      id: "lote-1",
      servicioId: SERVICIO_ID,
      fecha: FECHA_DATE,
      horaInicio: "09:00",
      horaFinUltimoHeat: "09:15",
      horaInicioLimpieza: "09:15",
      horaFinLimpieza: "09:30",
      cantidadHeats: 1,
    });
    const heat = fake.crearHeat({
      id: "heat-1",
      loteId: lote.id,
      servicioId: SERVICIO_ID,
      fecha: FECHA_DATE,
      horaInicio: "09:00",
      horaFin: "09:15",
      posicionEnLote: 1,
    });

    const ahora = Date.now();
    fake.crearReservaConAsignacion({
      heatId: heat.id, servicioId: SERVICIO_ID, fecha: FECHA_DATE,
      cantidadParticipantes: 1, estado: "CONFIRMADA",
    });
    fake.crearReservaConAsignacion({
      heatId: heat.id, servicioId: SERVICIO_ID, fecha: FECHA_DATE,
      cantidadParticipantes: 1, estado: "TEMPORAL", expiraEn: new Date(ahora + 10 * 60 * 1000),
    });
    fake.crearReservaConAsignacion({
      // Retencion vencida: NO debe contarse (6.7.6, glosario "reserva temporal").
      heatId: heat.id, servicioId: SERVICIO_ID, fecha: FECHA_DATE,
      cantidadParticipantes: 2, estado: "TEMPORAL", expiraEn: new Date(ahora - 10 * 60 * 1000),
    });
    fake.crearReservaConAsignacion({
      heatId: heat.id, servicioId: SERVICIO_ID, fecha: FECHA_DATE,
      cantidadParticipantes: 1, estado: "PENDIENTE_VALIDACION_SINPE",
    });

    // Ocupado real = 1 (confirmada) + 1 (temporal vigente) + 1 (SINPE pendiente) = 3; libres = 2.
    const cabeEnElLibre = await consultarDisponibilidad(comoPrisma(fake), {
      servicioId: SERVICIO_ID, fecha: FECHA_ISO, horaInicioCandidata: "09:00", cantidadPersonas: 2,
    });
    expect(cabeEnElLibre.disponible).toBe(true);

    const noCabe = await consultarDisponibilidad(comoPrisma(fake), {
      servicioId: SERVICIO_ID, fecha: FECHA_ISO, horaInicioCandidata: "09:00", cantidadPersonas: 3,
    });
    expect(noCabe.disponible).toBe(false);
  });

  it("un bloqueo administrativo impide usar ese intervalo (6.6, 8.2)", async () => {
    const fake = new FakePrisma();
    crearFixtureBase(fake);
    fake.crearBloqueo({
      id: "block-1", servicioId: SERVICIO_ID, fecha: FECHA_DATE,
      horaInicio: "09:00", horaFin: "09:15", motivo: "Mantenimiento",
    });

    const resultado = await consultarDisponibilidad(comoPrisma(fake), {
      servicioId: SERVICIO_ID, fecha: FECHA_ISO, horaInicioCandidata: "09:00", cantidadPersonas: 5,
    });

    expect(resultado.disponible).toBe(false);
  });

  it("incluye el precio cuando el servicio tiene tarifa configurada (13.1)", async () => {
    const fake = new FakePrisma();
    crearFixtureBase(fake); // precioPorPersona: 4000, porcentajeDeposito: 50

    const resultado = await consultarDisponibilidad(comoPrisma(fake), {
      servicioId: SERVICIO_ID, fecha: FECHA_ISO, horaInicioCandidata: "09:00", cantidadPersonas: 5,
    });

    expect(resultado.disponible).toBe(true);
    if (!resultado.disponible) return;
    expect(resultado.precio).toEqual({
      moneda: "CRC", montoTotal: 20000, montoDeposito: 10000, montoSaldo: 10000,
    });
  });

  it("no incluye precio cuando el servicio aun no tiene tarifa configurada (8.1)", async () => {
    const fake = new FakePrisma();
    // Sin crearServicio: `service.findUnique` devuelve null (servicio sin fila de tarifa).
    fake.crearPlantilla({
      id: "tpl-1", servicioId: SERVICIO_ID, diaSemana: DIA_SEMANA_DOMINGO,
      horaApertura: "09:00", horaCierre: "16:00", almuerzoInicio: "12:00", almuerzoFin: "12:30", activo: true,
    });

    const resultado = await consultarDisponibilidad(comoPrisma(fake), {
      servicioId: SERVICIO_ID, fecha: FECHA_ISO, horaInicioCandidata: "09:00", cantidadPersonas: 5,
    });

    expect(resultado.disponible).toBe(true);
    if (!resultado.disponible) return;
    expect(resultado.precio).toBeUndefined();
  });

  it("el plan publico nunca expone la limpieza (8.7, glosario 'fin de actividad del cliente')", async () => {
    const fake = new FakePrisma();
    crearFixtureBase(fake);

    const resultado = await consultarDisponibilidad(comoPrisma(fake), {
      servicioId: SERVICIO_ID, fecha: FECHA_ISO, horaInicioCandidata: "09:00", cantidadPersonas: 5,
    });

    expect(resultado.disponible).toBe(true);
    if (!resultado.disponible) return;
    expect("liberacionOperativa" in resultado).toBe(false);
    expect("horaFinLimpieza" in resultado.lotes[0]!).toBe(false);
  });

  it("una excepcion cuya `fecha` tiene una hora distinta de medianoche igual se reconoce (misma fecha calendario, @db.Date no guarda hora)", async () => {
    const fake = new FakePrisma();
    crearFixtureBase(fake);
    // Fecha con hora 08:30 UTC en vez de medianoche: en Postgres real (columna
    // @db.Date) esto seria indistinguible de FECHA_DATE; el fake debe
    // reconocerlas como la misma fecha (ver `mismaFecha`).
    const fechaConHora = new Date("2026-09-13T08:30:00.000Z");
    fake.crearExcepcion({ id: "exc-1", servicioId: SERVICIO_ID, fecha: fechaConHora, tipo: "CERRADO" });

    const resultado = await consultarDisponibilidad(comoPrisma(fake), {
      servicioId: SERVICIO_ID, fecha: FECHA_ISO, horaInicioCandidata: "09:00", cantidadPersonas: 5,
    });

    expect(resultado.disponible).toBe(false);
  });
});

describe("consultarDisponibilidadDelDia", () => {
  it("construye el ContextoDisponibilidad UNA SOLA VEZ y lo reutiliza para los 96 candidatos del dia (8.7)", async () => {
    const fake = new FakePrisma();
    crearFixtureBase(fake);
    const espia = vi.spyOn(fake.heat, "findMany");

    const candidatos = await consultarDisponibilidadDelDia(comoPrisma(fake), SERVICIO_ID, FECHA_ISO, 5);

    // Un candidato por cada intervalo de 15 minutos del dia completo.
    expect(candidatos).toHaveLength(96);
    // La query de heats (parte de construirContextoDisponibilidad) se disparo
    // una sola vez, no una vez por candidato evaluado.
    expect(espia).toHaveBeenCalledTimes(1);

    const candidato0900 = candidatos.find((c) => c.horaInicioCandidata === "09:00")!;
    expect(candidato0900.plan.disponible).toBe(true);
    const candidatoCerrado = candidatos.find((c) => c.horaInicioCandidata === "02:00")!;
    expect(candidatoCerrado.plan.disponible).toBe(false);
  });
});

describe("confirmarReserva", () => {
  it("confirma una reserva nueva: crea lote/heat/asignacion y oculta la limpieza en el plan devuelto", async () => {
    const fake = new FakePrisma();
    crearFixtureBase(fake);

    const resultado = await confirmarReserva(comoPrisma(fake), {
      servicioId: SERVICIO_ID, fecha: FECHA_ISO, horaInicioCandidata: "09:00", cantidadPersonas: 5,
      cliente: { nombre: "Ana", telefono: "8888-0000" },
      claveIdempotencia: "idem-1",
    });

    expect(resultado.exito).toBe(true);
    if (!resultado.exito) return;
    expect(resultado.idReserva).toBeTruthy();
    expect(resultado.codigoPublico).toBeTruthy();
    expect("liberacionOperativa" in resultado.plan).toBe(false);

    expect(fake.reservas).toHaveLength(1);
    expect(fake.reservas[0]!.estado).toBe("TEMPORAL");
    expect(fake.lotes).toHaveLength(1);
    expect(fake.heats).toHaveLength(1);
    expect(fake.asignaciones).toHaveLength(1);
    expect(fake.asignaciones[0]!.cantidadParticipantes).toBe(5);
  });

  it("una segunda confirmacion con la misma clave de idempotencia no crea una segunda reserva (8.8.7)", async () => {
    const fake = new FakePrisma();
    crearFixtureBase(fake);
    const solicitud = {
      servicioId: SERVICIO_ID, fecha: FECHA_ISO, horaInicioCandidata: "09:00", cantidadPersonas: 5,
      cliente: { nombre: "Ana", telefono: "8888-0000" },
      claveIdempotencia: "idem-repetida",
    };

    const primera = await confirmarReserva(comoPrisma(fake), solicitud);
    const segunda = await confirmarReserva(comoPrisma(fake), solicitud);

    expect(primera.exito).toBe(true);
    expect(segunda.exito).toBe(true);
    if (!primera.exito || !segunda.exito) return;
    expect(segunda.idReserva).toBe(primera.idReserva);
    expect(fake.reservas).toHaveLength(1);
    expect(fake.heats).toHaveLength(1);
  });

  it("devuelve NO_DISPONIBLE sin crear nada si el plan no cabe ese dia", async () => {
    const fake = new FakePrisma();
    fake.crearServicio({ id: SERVICIO_ID });
    fake.crearPlantilla({
      id: "tpl-1", servicioId: SERVICIO_ID, diaSemana: DIA_SEMANA_DOMINGO, activo: false, // fecha cerrada
    });

    const resultado = await confirmarReserva(comoPrisma(fake), {
      servicioId: SERVICIO_ID, fecha: FECHA_ISO, horaInicioCandidata: "09:00", cantidadPersonas: 5,
      cliente: { nombre: "Ana", telefono: "8888-0000" },
      claveIdempotencia: "idem-cerrado",
    });

    expect(resultado.exito).toBe(false);
    if (resultado.exito) return;
    expect(resultado.motivo).toBe("NO_DISPONIBLE");
    expect(fake.reservas).toHaveLength(0);
  });

  it("si otra transaccion gana la carrera por el heat, reintenta con contexto fresco y confirma en el segundo intento (8.8.6)", async () => {
    const fake = new FakePrisma();
    crearFixtureBase(fake);
    fake.forzarConflictoUnico("heat", "heats_service_id_fecha_hora_inicio_key", 1);

    const resultado = await confirmarReserva(comoPrisma(fake), {
      servicioId: SERVICIO_ID, fecha: FECHA_ISO, horaInicioCandidata: "09:00", cantidadPersonas: 5,
      cliente: { nombre: "Ana", telefono: "8888-0000" },
      claveIdempotencia: "idem-retry",
    });

    expect(resultado.exito).toBe(true);
    // El intento fallido no debe dejar una reserva huerfana (rollback del fake).
    expect(fake.reservas).toHaveLength(1);
    expect(fake.heats).toHaveLength(1);
  });

  it("si el conflicto persiste en todos los intentos, devuelve CONFLICTO_CONCURRENCIA sin dejar filas huerfanas (8.8.6)", async () => {
    const fake = new FakePrisma();
    crearFixtureBase(fake);
    const intentosMaximos = 3;
    fake.forzarConflictoUnico("heat", "heats_service_id_fecha_hora_inicio_key", intentosMaximos);

    const resultado = await confirmarReserva(
      comoPrisma(fake),
      {
        servicioId: SERVICIO_ID, fecha: FECHA_ISO, horaInicioCandidata: "09:00", cantidadPersonas: 5,
        cliente: { nombre: "Ana", telefono: "8888-0000" },
        claveIdempotencia: "idem-agotado",
      },
      intentosMaximos,
    );

    expect(resultado.exito).toBe(false);
    if (resultado.exito) return;
    expect(resultado.motivo).toBe("CONFLICTO_CONCURRENCIA");
    expect(fake.reservas).toHaveLength(0);
    expect(fake.heats).toHaveLength(0);
  });

  it("si un heat nuevo queda colocado cronologicamente antes de un heat reutilizado del mismo lote, ambos terminan con posicionEnLote distinto (6.1.12)", async () => {
    const fake = new FakePrisma();
    crearFixtureBase(fake);
    const lote = fake.crearLote({
      id: "lote-1", servicioId: SERVICIO_ID, fecha: FECHA_DATE,
      horaInicio: "09:15", horaFinUltimoHeat: "09:30",
      horaInicioLimpieza: "09:30", horaFinLimpieza: "09:45", cantidadHeats: 1,
    });
    fake.crearHeat({
      id: "heat-existente", loteId: lote.id, servicioId: SERVICIO_ID, fecha: FECHA_DATE,
      horaInicio: "09:15", horaFin: "09:30", posicionEnLote: 1,
    });
    fake.crearReservaConAsignacion({
      heatId: "heat-existente", servicioId: SERVICIO_ID, fecha: FECHA_DATE,
      cantidadParticipantes: 2, estado: "CONFIRMADA",
    });

    // 7 personas desde las 09:00: necesita 2 heats ([4,3]); el primero es
    // nuevo (09:00), el segundo reutiliza "heat-existente" (09:15, con 3 de
    // los 3 espacios libres). El heat reutilizado queda en la posicion 2,
    // no en la 1 que tenia antes de esta reserva.
    const resultado = await confirmarReserva(comoPrisma(fake), {
      servicioId: SERVICIO_ID, fecha: FECHA_ISO, horaInicioCandidata: "09:00", cantidadPersonas: 7,
      cliente: { nombre: "Ana", telefono: "8888-0000" },
      claveIdempotencia: "idem-posicion",
    });

    expect(resultado.exito).toBe(true);
    if (!resultado.exito) return;

    expect(fake.heats).toHaveLength(2);
    const heatExistente = fake.heats.find((h) => h.id === "heat-existente")!;
    const heatNuevo = fake.heats.find((h) => h.id !== "heat-existente")!;
    expect(heatNuevo.horaInicio).toBe("09:00");
    expect(heatExistente.horaInicio).toBe("09:15");
    expect(heatNuevo.posicionEnLote).toBe(1);
    expect(heatExistente.posicionEnLote).toBe(2); // actualizada; ya no es 1
    expect(heatNuevo.posicionEnLote).not.toBe(heatExistente.posicionEnLote);
  });

  it("si la capacidad cambia entre la lectura inicial y el lock, la ronda de estabilizacion recalcula y detecta que ya no cabe (8.8.3-4)", async () => {
    const fake = new FakePrisma();
    crearFixtureBase(fake);
    const lote = fake.crearLote({
      id: "lote-1", servicioId: SERVICIO_ID, fecha: FECHA_DATE,
      horaInicio: "09:00", horaFinUltimoHeat: "09:15",
      horaInicioLimpieza: "09:15", horaFinLimpieza: "09:30", cantidadHeats: 1,
    });
    fake.crearHeat({
      id: "heat-1", loteId: lote.id, servicioId: SERVICIO_ID, fecha: FECHA_DATE,
      horaInicio: "09:00", horaFin: "09:15", posicionEnLote: 1,
    });
    fake.crearReservaConAsignacion({
      heatId: "heat-1", servicioId: SERVICIO_ID, fecha: FECHA_DATE,
      cantidadParticipantes: 2, estado: "CONFIRMADA",
    });

    // En el momento del lock (primera ronda), otra transaccion "gana" los 3
    // espacios restantes justo antes de que recalculemos bajo lock.
    fake.onQueryRaw = () => {
      fake.crearReservaConAsignacion({
        heatId: "heat-1", servicioId: SERVICIO_ID, fecha: FECHA_DATE,
        cantidadParticipantes: 3, estado: "CONFIRMADA",
      });
      fake.onQueryRaw = null; // una sola vez
    };

    const resultado = await confirmarReserva(comoPrisma(fake), {
      servicioId: SERVICIO_ID, fecha: FECHA_ISO, horaInicioCandidata: "09:00", cantidadPersonas: 2,
      cliente: { nombre: "Ana", telefono: "8888-0000" },
      claveIdempotencia: "idem-estabilizacion",
    });

    expect(resultado.exito).toBe(false);
    if (resultado.exito) return;
    expect(resultado.motivo).toBe("NO_DISPONIBLE");
    // La reserva confirmada del fixture (2) + la "competidora" inyectada por
    // el hook (3); la nuestra nunca se creo.
    expect(fake.reservas).toHaveLength(2);
  });

  it("si el plan nunca se estabiliza bajo lock, se agotan las rondas y confirmarReserva lo trata como conflicto de concurrencia (8.8.6)", async () => {
    const fake = new FakePrisma();
    crearFixtureBase(fake);
    const lote = fake.crearLote({
      id: "lote-1", servicioId: SERVICIO_ID, fecha: FECHA_DATE,
      horaInicio: "09:00", horaFinUltimoHeat: "09:15",
      horaInicioLimpieza: "09:15", horaFinLimpieza: "09:30", cantidadHeats: 1,
    });
    fake.crearHeat({
      id: "heat-original", loteId: lote.id, servicioId: SERVICIO_ID, fecha: FECHA_DATE,
      horaInicio: "09:00", horaFin: "09:15", posicionEnLote: 1,
    });
    fake.crearReservaConAsignacion({
      heatId: "heat-original", servicioId: SERVICIO_ID, fecha: FECHA_DATE,
      cantidadParticipantes: 2, estado: "CONFIRMADA",
    });

    // El heat reutilizado "cambia de identidad" cada vez que se intenta
    // bloquear: el plan recalculado despues del lock siempre referencia un
    // id nuevo, sin bloquear, asi que el bucle de estabilizacion nunca
    // encuentra un punto fijo.
    let contador = 0;
    fake.onQueryRaw = () => {
      contador += 1;
      const heatActual = fake.heats.find(
        (h) => h.horaInicio === "09:00" && h.servicioId === SERVICIO_ID,
      )!;
      const idAnterior = heatActual.id;
      heatActual.id = `heat-swap-${contador}`;
      for (const asignacion of fake.asignaciones) {
        if (asignacion.heatId === idAnterior) asignacion.heatId = heatActual.id;
      }
    };

    const resultado = await confirmarReserva(comoPrisma(fake), {
      servicioId: SERVICIO_ID, fecha: FECHA_ISO, horaInicioCandidata: "09:00", cantidadPersonas: 2,
      cliente: { nombre: "Ana", telefono: "8888-0000" },
      claveIdempotencia: "idem-inestable",
    });

    expect(resultado.exito).toBe(false);
    if (resultado.exito) return;
    expect(resultado.motivo).toBe("CONFLICTO_CONCURRENCIA");
    // Solo la reserva confirmada del fixture; la nuestra nunca se creo (el
    // rollback del fake descarta cualquier intento fallido).
    expect(fake.reservas).toHaveLength(1);
    expect(contador).toBeGreaterThan(1); // se ejecuto mas de una ronda antes de agotarse
  });

  it("si otra transaccion crea la reserva competidora con la misma clave de idempotencia justo antes de nuestro create, devolvemos esa reserva sin duplicar (8.8.7, 8.8.6)", async () => {
    const fake = new FakePrisma();
    crearFixtureBase(fake);
    const claveIdempotencia = "idem-carrera";

    fake.forzarConflictoUnico("reservation", "reservations_clave_idempotencia_key", 1);
    fake.onReservationFindUnique = () => {
      fake.reservas.push({
        id: "res-competidora",
        codigoPublico: "SRP-COMPETIDORA",
        servicioId: SERVICIO_ID,
        fecha: FECHA_DATE,
        cantidadPersonas: 5,
        estado: "TEMPORAL",
        moneda: "CRC",
        montoTotal: 20000,
        montoDeposito: 10000,
        montoSaldo: 10000,
        claveIdempotencia,
        clienteNombre: "Otro cliente",
        clienteTelefono: "00000000",
        expiraEn: new Date(Date.now() + 30 * 60 * 1000),
      });
      fake.onReservationFindUnique = null; // una sola vez
    };

    const resultado = await confirmarReserva(comoPrisma(fake), {
      servicioId: SERVICIO_ID, fecha: FECHA_ISO, horaInicioCandidata: "09:00", cantidadPersonas: 5,
      cliente: { nombre: "Ana", telefono: "8888-0000" },
      claveIdempotencia,
    });

    expect(resultado.exito).toBe(true);
    if (!resultado.exito) return;
    expect(resultado.idReserva).toBe("res-competidora");
    expect(fake.reservas).toHaveLength(1); // la nuestra nunca se creo
    expect(fake.heats).toHaveLength(0);
  });

  it("una colision del codigo publico generado se reintenta y confirma en el siguiente intento (8.8.6)", async () => {
    const fake = new FakePrisma();
    crearFixtureBase(fake);
    fake.forzarConflictoUnico("reservation", "reservations_public_code_key", 1);

    const resultado = await confirmarReserva(comoPrisma(fake), {
      servicioId: SERVICIO_ID, fecha: FECHA_ISO, horaInicioCandidata: "09:00", cantidadPersonas: 5,
      cliente: { nombre: "Ana", telefono: "8888-0000" },
      claveIdempotencia: "idem-publiccode-retry",
    });

    expect(resultado.exito).toBe(true);
    if (!resultado.exito) return;
    // El intento fallido no debe dejar una reserva huerfana (rollback del fake).
    expect(fake.reservas).toHaveLength(1);
    expect(fake.heats).toHaveLength(1);
  });
});
