import { describe, expect, it } from "vitest";
import {
  construirPlan,
  construirPlanConRepeticiones,
  horaAMinutos,
  minutosAHora,
  normalizarLoteTrasLiberacion,
  type BloqueDeCalendario,
  type BloqueHeat,
  type BloqueLimpieza,
  type ContextoDisponibilidad,
  type FechaISO,
  type HeatParaNormalizar,
  type HoraISO,
} from "./motor-disponibilidad.js";

// Casos de prueba prioritarios del motor de disponibilidad (seccion 24 de
// propuesta.md). Los 21 casos DISP-001..021 tienen ahora asercion real.

const FECHA_PRUEBA: FechaISO = "2026-09-13"; // domingo, horario habitual (6.2)
const SERVICIO_PRUEBA = "svc-karts";
const APERTURA: HoraISO = "09:00";
const CIERRE: HoraISO = "16:00";
const ALMUERZO_INICIO: HoraISO = "12:00";
const ALMUERZO_FIN: HoraISO = "12:30";

/** Rejilla de un dia completamente vacio (sin heats, lotes ni bloqueos), con
 * el horario habitual de 6.2: 9:00-16:00, almuerzo 12:00-12:30. */
function crearContextoDiaVacio(): ContextoDisponibilidad {
  const bloques: BloqueDeCalendario[] = [];
  for (let minuto = 0; minuto < 24 * 60; minuto += 15) {
    const horaInicio = minutosAHora(minuto);
    const horaFin = minutosAHora(minuto + 15);
    const enAlmuerzo =
      minuto >= horaAMinutos(ALMUERZO_INICIO) && minuto + 15 <= horaAMinutos(ALMUERZO_FIN);
    const enHorario =
      minuto >= horaAMinutos(APERTURA) && minuto + 15 <= horaAMinutos(CIERRE);

    if (enAlmuerzo) {
      bloques.push({ tipo: "almuerzo", fecha: FECHA_PRUEBA, horaInicio, horaFin });
    } else if (enHorario) {
      bloques.push({ tipo: "disponible", fecha: FECHA_PRUEBA, horaInicio, horaFin });
    } else {
      bloques.push({ tipo: "cerrado", fecha: FECHA_PRUEBA, horaInicio, horaFin });
    }
  }
  return { rejilla: bloques };
}

/** Sustituye bloques puntuales de un contexto (por horaInicio) para simular
 * heats y limpiezas ya existentes en base de datos, dejando el resto del dia
 * intacto. Util para reproducir los ejemplos de la seccion 9 de propuesta.md. */
function conBloques(
  contexto: ContextoDisponibilidad,
  bloques: readonly BloqueDeCalendario[],
): ContextoDisponibilidad {
  const mapa = new Map(contexto.rejilla.map((bloque) => [bloque.horaInicio, bloque]));
  for (const bloque of bloques) mapa.set(bloque.horaInicio, bloque);
  return {
    ...contexto,
    rejilla: [...mapa.values()].sort(
      (a, b) => horaAMinutos(a.horaInicio) - horaAMinutos(b.horaInicio),
    ),
  };
}

/** Heat ya existente en base de datos, con una ocupacion dada (6.5). */
function heatExistente(
  horaInicio: HoraISO,
  datos: {
    heatId: string;
    loteId: string;
    personasConfirmadas: number;
    personasRetenidas?: number;
  },
): BloqueHeat {
  const personasRetenidas = datos.personasRetenidas ?? 0;
  return {
    tipo: "heat",
    fecha: FECHA_PRUEBA,
    horaInicio,
    horaFin: minutosAHora(horaAMinutos(horaInicio) + 15),
    heatId: datos.heatId,
    loteId: datos.loteId,
    posicionEnLote: 1,
    personasConfirmadas: datos.personasConfirmadas,
    personasRetenidas,
    capacidadOcupada: datos.personasConfirmadas + personasRetenidas,
  };
}

/** Limpieza global de un lote existente (6.1.6-7). */
function limpiezaDeLote(horaInicio: HoraISO, loteId: string): BloqueLimpieza {
  return {
    tipo: "limpieza",
    fecha: FECHA_PRUEBA,
    horaInicio,
    horaFin: minutosAHora(horaAMinutos(horaInicio) + 15),
    loteId,
  };
}

describe("Motor de disponibilidad — casos DISP", () => {
  it("DISP-001: reserva de 5 personas en dia vacio -> un heat y una limpieza", () => {
    const resultado = construirPlan({
      fecha: FECHA_PRUEBA,
      horaInicioCandidata: "09:00",
      cantidadPersonas: 5,
      servicioId: SERVICIO_PRUEBA,
      contexto: crearContextoDiaVacio(),
    });

    expect(resultado.disponible).toBe(true);
    if (!resultado.disponible) return;

    expect(resultado.cantidadLotes).toBe(1);
    expect(resultado.distribucion).toEqual([5]);
    expect(resultado.lotes).toHaveLength(1);
    expect(resultado.lotes[0]!.heats).toEqual([
      expect.objectContaining({
        horaInicio: "09:00",
        horaFin: "09:15",
        personasAsignadas: 5,
        esHeatReutilizado: false,
      }),
    ]);
    expect(resultado.horaFinActividadCliente).toBe("09:15");
    expect(resultado.liberacionOperativa).toBe("09:30");
  });

  it("DISP-002: reserva de 6 personas en dia vacio -> dos heats de 3 + 3; primera opcion 9:00; limpieza interna posterior", () => {
    const resultado = construirPlan({
      fecha: FECHA_PRUEBA,
      horaInicioCandidata: "09:00",
      cantidadPersonas: 6,
      servicioId: SERVICIO_PRUEBA,
      contexto: crearContextoDiaVacio(),
    });

    expect(resultado.disponible).toBe(true);
    if (!resultado.disponible) return;

    expect(resultado.cantidadLotes).toBe(1);
    expect(resultado.distribucion).toEqual([3, 3]);
    const [lote] = resultado.lotes;
    expect(lote!.heats.map((h) => [h.horaInicio, h.horaFin, h.personasAsignadas])).toEqual([
      ["09:00", "09:15", 3],
      ["09:15", "09:30", 3],
    ]);
    expect(resultado.horaFinActividadCliente).toBe("09:30");
    expect(resultado.liberacionOperativa).toBe("09:45");
  });

  it("DISP-003: reserva de 15 personas en dia vacio -> tres heats de 5 + 5 + 5; primera opcion 9:00", () => {
    const resultado = construirPlan({
      fecha: FECHA_PRUEBA,
      horaInicioCandidata: "09:00",
      cantidadPersonas: 15,
      servicioId: SERVICIO_PRUEBA,
      contexto: crearContextoDiaVacio(),
    });

    expect(resultado.disponible).toBe(true);
    if (!resultado.disponible) return;

    expect(resultado.cantidadLotes).toBe(1);
    expect(resultado.distribucion).toEqual([5, 5, 5]);
    const [lote] = resultado.lotes;
    expect(lote!.heats.map((h) => h.personasAsignadas)).toEqual([5, 5, 5]);
    expect(lote!.heats[0]!.horaInicio).toBe("09:00");
    expect(resultado.horaFinActividadCliente).toBe("09:45");
    expect(resultado.liberacionOperativa).toBe("10:00");
  });

  it("DISP-004: reserva de 16 personas en dia vacio -> cuatro heats de 4 + 4 + 4 + 4; primera opcion 9:00", () => {
    const resultado = construirPlan({
      fecha: FECHA_PRUEBA,
      horaInicioCandidata: "09:00",
      cantidadPersonas: 16,
      servicioId: SERVICIO_PRUEBA,
      contexto: crearContextoDiaVacio(),
    });

    expect(resultado.disponible).toBe(true);
    if (!resultado.disponible) return;

    expect(resultado.cantidadLotes).toBe(1);
    expect(resultado.distribucion).toEqual([4, 4, 4, 4]);
    const [lote] = resultado.lotes;
    expect(lote!.heats.map((h) => h.personasAsignadas)).toEqual([4, 4, 4, 4]);
    expect(resultado.horaFinActividadCliente).toBe("10:00");
    expect(resultado.liberacionOperativa).toBe("10:15");
  });

  it("DISP-005: heat con 2 personas y nueva reserva de 3 -> comparten el heat", () => {
    const contexto = conBloques(crearContextoDiaVacio(), [
      heatExistente("09:00", { heatId: "heat-1", loteId: "lote-1", personasConfirmadas: 2 }),
      limpiezaDeLote("09:15", "lote-1"),
    ]);

    const resultado = construirPlan({
      fecha: FECHA_PRUEBA,
      horaInicioCandidata: "09:00",
      cantidadPersonas: 3,
      servicioId: SERVICIO_PRUEBA,
      contexto,
    });

    expect(resultado.disponible).toBe(true);
    if (!resultado.disponible) return;

    expect(resultado.cantidadLotes).toBe(1);
    const [lote] = resultado.lotes;
    expect(lote!.esLoteReutilizado).toBe(true);
    expect(lote!.loteId).toBe("lote-1");
    expect(lote!.heats).toEqual([
      expect.objectContaining({
        heatId: "heat-1",
        horaInicio: "09:00",
        horaFin: "09:15",
        personasAsignadas: 3,
        esHeatReutilizado: true,
      }),
    ]);
    expect(resultado.horaFinActividadCliente).toBe("09:15");
    expect(resultado.liberacionOperativa).toBe("09:30");
  });

  it("DISP-006: heat con 2 personas y nueva reserva de 4 -> la hora no se ofrece; el grupo no cabe en un heat", () => {
    const contexto = conBloques(crearContextoDiaVacio(), [
      heatExistente("09:00", { heatId: "heat-1", loteId: "lote-1", personasConfirmadas: 2 }),
      limpiezaDeLote("09:15", "lote-1"),
    ]);

    const resultado = construirPlan({
      fecha: FECHA_PRUEBA,
      horaInicioCandidata: "09:00",
      cantidadPersonas: 4,
      servicioId: SERVICIO_PRUEBA,
      contexto,
    });

    expect(resultado.disponible).toBe(false);
    if (resultado.disponible) return;
    expect(resultado.motivo).toBe("SIN_HEATS_CONSECUTIVOS_DISPONIBLES");
  });

  it("DISP-007: heat de 11:45 con almuerzo a las 12:00 -> no puede ser el ultimo heat de un lote porque la limpieza se cruza", () => {
    const resultado = construirPlan({
      fecha: FECHA_PRUEBA,
      horaInicioCandidata: "11:45",
      cantidadPersonas: 5,
      servicioId: SERVICIO_PRUEBA,
      contexto: crearContextoDiaVacio(),
    });

    expect(resultado.disponible).toBe(false);
    if (resultado.disponible) return;
    expect(resultado.motivo).toBe("CRUCE_CON_BLOQUE_NO_DISPONIBLE");
  });

  it("DISP-008: ocho personas desde 11:30 -> la hora no se ofrece porque el lote y su limpieza cruzan el almuerzo", () => {
    const resultado = construirPlan({
      fecha: FECHA_PRUEBA,
      horaInicioCandidata: "11:30",
      cantidadPersonas: 8,
      servicioId: SERVICIO_PRUEBA,
      contexto: crearContextoDiaVacio(),
    });

    expect(resultado.disponible).toBe(false);
    if (resultado.disponible) return;
    expect(resultado.motivo).toBe("CRUCE_CON_BLOQUE_NO_DISPONIBLE");
  });

  it("DISP-009: veinte personas desde 11:00 -> quince antes del almuerzo y cinco despues, en dos lotes", () => {
    const resultado = construirPlan({
      fecha: FECHA_PRUEBA,
      horaInicioCandidata: "11:00",
      cantidadPersonas: 20,
      servicioId: SERVICIO_PRUEBA,
      contexto: crearContextoDiaVacio(),
    });

    expect(resultado.disponible).toBe(true);
    if (!resultado.disponible) return;

    // Ejemplo 9.15 de propuesta.md: lote 1 = 15 personas antes del almuerzo,
    // lote 2 = 5 personas despues (12:30-12:45).
    expect(resultado.cantidadLotes).toBe(2);
    expect(resultado.distribucion).toEqual([5, 5, 5, 5]);

    const [lote1, lote2] = resultado.lotes;
    expect(lote1!.heats.map((h) => [h.horaInicio, h.horaFin, h.personasAsignadas])).toEqual([
      ["11:00", "11:15", 5],
      ["11:15", "11:30", 5],
      ["11:30", "11:45", 5],
    ]);
    expect(lote1!.horaFinActividadCliente).toBe("11:45");
    expect(lote1!.horaFinLimpieza).toBe("12:00");

    expect(lote2!.heats).toEqual([
      expect.objectContaining({ horaInicio: "12:30", horaFin: "12:45", personasAsignadas: 5 }),
    ]);
    expect(lote2!.horaFinActividadCliente).toBe("12:45");
    expect(lote2!.horaFinLimpieza).toBe("13:00");

    expect(resultado.horaFinActividadCliente).toBe("12:45");
    expect(resultado.liberacionOperativa).toBe("13:00");
  });

  it("DISP-010: heat completo a las 10:00 y diez personas desde 9:30 -> la hora no se ofrece porque la limpieza del lote se cruza con el heat existente", () => {
    const contexto = conBloques(crearContextoDiaVacio(), [
      heatExistente("10:00", { heatId: "heat-1", loteId: "lote-1", personasConfirmadas: 5 }),
      limpiezaDeLote("10:15", "lote-1"),
    ]);

    const resultado = construirPlan({
      fecha: FECHA_PRUEBA,
      horaInicioCandidata: "09:30",
      cantidadPersonas: 10,
      servicioId: SERVICIO_PRUEBA,
      contexto,
    });

    expect(resultado.disponible).toBe(false);
    if (resultado.disponible) return;
    expect(resultado.motivo).toBe("CRUCE_CON_BLOQUE_NO_DISPONIBLE");
  });

  it("DISP-011: heat completo a las 10:00 y diez personas desde 9:15 -> dos heats y limpieza terminan exactamente a las 10:00", () => {
    const contexto = conBloques(crearContextoDiaVacio(), [
      heatExistente("10:00", { heatId: "heat-1", loteId: "lote-1", personasConfirmadas: 5 }),
      limpiezaDeLote("10:15", "lote-1"),
    ]);

    const resultado = construirPlan({
      fecha: FECHA_PRUEBA,
      horaInicioCandidata: "09:15",
      cantidadPersonas: 10,
      servicioId: SERVICIO_PRUEBA,
      contexto,
    });

    expect(resultado.disponible).toBe(true);
    if (!resultado.disponible) return;

    expect(resultado.cantidadLotes).toBe(1);
    const [lote] = resultado.lotes;
    expect(lote!.heats.map((h) => [h.horaInicio, h.horaFin, h.personasAsignadas])).toEqual([
      ["09:15", "09:30", 5],
      ["09:30", "09:45", 5],
    ]);
    expect(resultado.horaFinActividadCliente).toBe("09:45");
    expect(resultado.liberacionOperativa).toBe("10:00");
  });

  it("DISP-012: ultimo heat a las 3:30 -> permitido; limpieza termina a las 4:00", () => {
    const resultado = construirPlan({
      fecha: FECHA_PRUEBA,
      horaInicioCandidata: "15:30",
      cantidadPersonas: 5,
      servicioId: SERVICIO_PRUEBA,
      contexto: crearContextoDiaVacio(),
    });

    expect(resultado.disponible).toBe(true);
    if (!resultado.disponible) return;

    expect(resultado.horaFinActividadCliente).toBe("15:45");
    expect(resultado.liberacionOperativa).toBe("16:00");
  });

  it("DISP-013: diez personas desde las 3:15 -> dos heats y limpieza terminan a las 4:00", () => {
    const resultado = construirPlan({
      fecha: FECHA_PRUEBA,
      horaInicioCandidata: "15:15",
      cantidadPersonas: 10,
      servicioId: SERVICIO_PRUEBA,
      contexto: crearContextoDiaVacio(),
    });

    expect(resultado.disponible).toBe(true);
    if (!resultado.disponible) return;

    expect(resultado.distribucion).toEqual([5, 5]);
    expect(resultado.horaFinActividadCliente).toBe("15:45");
    expect(resultado.liberacionOperativa).toBe("16:00");
  });

  it("DISP-014: quince personas desde las 3:00 -> tres heats y limpieza terminan a las 4:00", () => {
    const resultado = construirPlan({
      fecha: FECHA_PRUEBA,
      horaInicioCandidata: "15:00",
      cantidadPersonas: 15,
      servicioId: SERVICIO_PRUEBA,
      contexto: crearContextoDiaVacio(),
    });

    expect(resultado.disponible).toBe(true);
    if (!resultado.disponible) return;

    expect(resultado.distribucion).toEqual([5, 5, 5]);
    expect(resultado.horaFinActividadCliente).toBe("15:45");
    expect(resultado.liberacionOperativa).toBe("16:00");
  });

  it("DISP-015: ampliar un lote de uno a dos heats -> se mueve la limpieza solo si el nuevo intervalo esta libre", () => {
    const contexto = conBloques(crearContextoDiaVacio(), [
      heatExistente("10:00", { heatId: "heat-1", loteId: "lote-1", personasConfirmadas: 2 }),
      limpiezaDeLote("10:15", "lote-1"),
    ]);

    const resultado = construirPlan({
      fecha: FECHA_PRUEBA,
      horaInicioCandidata: "10:00",
      cantidadPersonas: 7,
      servicioId: SERVICIO_PRUEBA,
      contexto,
    });

    expect(resultado.disponible).toBe(true);
    if (!resultado.disponible) return;

    // Ejemplo 9.9 de propuesta.md: el heat existente absorbe 3 personas y se
    // crea un segundo heat consecutivo con las 4 restantes; la limpieza se
    // desplaza de 10:15 a 10:30 porque ese nuevo intervalo esta libre.
    expect(resultado.cantidadLotes).toBe(1);
    const [lote] = resultado.lotes;
    expect(lote!.esLoteReutilizado).toBe(true);
    expect(lote!.loteId).toBe("lote-1");
    expect(lote!.heats).toEqual([
      expect.objectContaining({
        heatId: "heat-1",
        horaInicio: "10:00",
        horaFin: "10:15",
        personasAsignadas: 3,
        esHeatReutilizado: true,
      }),
      expect.objectContaining({
        heatId: null,
        horaInicio: "10:15",
        horaFin: "10:30",
        personasAsignadas: 4,
        esHeatReutilizado: false,
      }),
    ]);
    // distribucion debe reflejar el orden REAL de colocacion ([3, 4]), no el
    // vector canonico pre-permutacion ([4, 3]) que fallo por falta de capacidad.
    expect(resultado.distribucion).toEqual([3, 4]);
    expect(resultado.horaFinActividadCliente).toBe("10:30");
    expect(resultado.liberacionOperativa).toBe("10:45");
  });

  it("DISP-016: reserva de 7 personas -> distribucion 4 + 3 o 3 + 4; nunca 5 + 2", () => {
    const resultado = construirPlan({
      fecha: FECHA_PRUEBA,
      horaInicioCandidata: "09:00",
      cantidadPersonas: 7,
      servicioId: SERVICIO_PRUEBA,
      contexto: crearContextoDiaVacio(),
    });

    expect(resultado.disponible).toBe(true);
    if (!resultado.disponible) return;

    const asignaciones = resultado.lotes[0]!.heats.map((h) => h.personasAsignadas);
    expect([...asignaciones].sort((a, b) => b - a)).toEqual([4, 3]);
    expect(Math.max(...asignaciones) - Math.min(...asignaciones)).toBeLessThanOrEqual(1);
  });

  it("DISP-017: reserva de 11 personas -> distribucion 4 + 4 + 3 en cualquier orden compatible", () => {
    const resultado = construirPlan({
      fecha: FECHA_PRUEBA,
      horaInicioCandidata: "09:00",
      cantidadPersonas: 11,
      servicioId: SERVICIO_PRUEBA,
      contexto: crearContextoDiaVacio(),
    });

    expect(resultado.disponible).toBe(true);
    if (!resultado.disponible) return;

    const asignaciones = resultado.lotes[0]!.heats.map((h) => h.personasAsignadas);
    expect([...asignaciones].sort((a, b) => b - a)).toEqual([4, 4, 3]);
    expect(Math.max(...asignaciones) - Math.min(...asignaciones)).toBeLessThanOrEqual(1);
  });

  it("DISP-018: reserva de 14 personas -> distribucion 5 + 5 + 4 en cualquier orden compatible", () => {
    const resultado = construirPlan({
      fecha: FECHA_PRUEBA,
      horaInicioCandidata: "09:00",
      cantidadPersonas: 14,
      servicioId: SERVICIO_PRUEBA,
      contexto: crearContextoDiaVacio(),
    });

    expect(resultado.disponible).toBe(true);
    if (!resultado.disponible) return;

    const asignaciones = resultado.lotes[0]!.heats.map((h) => h.personasAsignadas);
    expect([...asignaciones].sort((a, b) => b - a)).toEqual([5, 5, 4]);
    expect(Math.max(...asignaciones) - Math.min(...asignaciones)).toBeLessThanOrEqual(1);
  });

  it("DISP-019: dia vacio, grupo de 5 -> ofrece 9:00, 9:15, 9:30 y cada inicio valido hasta 11:30 antes del almuerzo", () => {
    const contexto = crearContextoDiaVacio();
    const inicios = [
      "09:00", "09:15", "09:30", "09:45",
      "10:00", "10:15", "10:30", "10:45",
      "11:00", "11:15", "11:30",
    ];

    for (const horaInicioCandidata of inicios) {
      const resultado = construirPlan({
        fecha: FECHA_PRUEBA,
        horaInicioCandidata,
        cantidadPersonas: 5,
        servicioId: SERVICIO_PRUEBA,
        contexto,
      });
      expect(resultado.disponible).toBe(true);
    }

    const fueraDeRango = construirPlan({
      fecha: FECHA_PRUEBA,
      horaInicioCandidata: "11:45",
      cantidadPersonas: 5,
      servicioId: SERVICIO_PRUEBA,
      contexto,
    });
    expect(fueraDeRango.disponible).toBe(false);
  });

  it("DISP-020: dia vacio, grupo de 6 -> ofrece 9:00, 9:15, 9:30 y cada inicio valido hasta 11:15 antes del almuerzo", () => {
    const contexto = crearContextoDiaVacio();
    const inicios = [
      "09:00", "09:15", "09:30", "09:45",
      "10:00", "10:15", "10:30", "10:45",
      "11:00", "11:15",
    ];

    for (const horaInicioCandidata of inicios) {
      const resultado = construirPlan({
        fecha: FECHA_PRUEBA,
        horaInicioCandidata,
        cantidadPersonas: 6,
        servicioId: SERVICIO_PRUEBA,
        contexto,
      });
      expect(resultado.disponible).toBe(true);
    }

    const fueraDeRango = construirPlan({
      fecha: FECHA_PRUEBA,
      horaInicioCandidata: "11:30",
      cantidadPersonas: 6,
      servicioId: SERVICIO_PRUEBA,
      contexto,
    });
    expect(fueraDeRango.disponible).toBe(false);
  });

  it("DISP-021: grupo de 6 reservado a las 9:15; nueva solicitud de 5 -> no ofrece 9:00-9:45; el primer inicio libre es 10:00", () => {
    const contexto = conBloques(crearContextoDiaVacio(), [
      heatExistente("09:15", { heatId: "heat-1", loteId: "lote-1", personasConfirmadas: 3 }),
      heatExistente("09:30", { heatId: "heat-2", loteId: "lote-1", personasConfirmadas: 3 }),
      limpiezaDeLote("09:45", "lote-1"),
    ]);

    for (const horaInicioCandidata of ["09:00", "09:15", "09:30", "09:45"]) {
      const resultado = construirPlan({
        fecha: FECHA_PRUEBA,
        horaInicioCandidata,
        cantidadPersonas: 5,
        servicioId: SERVICIO_PRUEBA,
        contexto,
      });
      expect(resultado.disponible).toBe(false);
    }

    const resultado = construirPlan({
      fecha: FECHA_PRUEBA,
      horaInicioCandidata: "10:00",
      cantidadPersonas: 5,
      servicioId: SERVICIO_PRUEBA,
      contexto,
    });
    expect(resultado.disponible).toBe(true);
  });
});

describe("precio: tarifa escalonada por tamano de grupo", () => {
  const TARIFA = {
    servicioId: SERVICIO_PRUEBA,
    moneda: "CRC",
    precioPorPersonaGrupoPequeno: 100,
    precioPorPersonaGrupoGrande: 80,
    porcentajeDeposito: 50,
  };

  function precioPara(cantidadPersonas: number) {
    const resultado = construirPlan({
      fecha: FECHA_PRUEBA,
      horaInicioCandidata: "09:00",
      cantidadPersonas,
      servicioId: SERVICIO_PRUEBA,
      contexto: { ...crearContextoDiaVacio(), tarifa: TARIFA },
    });
    expect(resultado.disponible).toBe(true);
    if (!resultado.disponible) throw new Error("no disponible");
    return resultado.precio;
  }

  it("1-4 personas paga la tarifa individual", () => {
    expect(precioPara(4)).toEqual({ moneda: "CRC", montoTotal: 400, montoDeposito: 200, montoSaldo: 200 });
  });

  it("exactamente 5 personas ya paga la tarifa grupal (umbral inclusivo)", () => {
    expect(precioPara(5)).toEqual({ moneda: "CRC", montoTotal: 400, montoDeposito: 200, montoSaldo: 200 });
  });

  it("mas de 5 personas sigue pagando la tarifa grupal", () => {
    expect(precioPara(8)).toEqual({ moneda: "CRC", montoTotal: 640, montoDeposito: 320, montoSaldo: 320 });
  });

  it("sin tarifa configurada, el plan no incluye precio", () => {
    const resultado = construirPlan({
      fecha: FECHA_PRUEBA,
      horaInicioCandidata: "09:00",
      cantidadPersonas: 3,
      servicioId: SERVICIO_PRUEBA,
      contexto: crearContextoDiaVacio(),
    });
    expect(resultado.disponible).toBe(true);
    if (!resultado.disponible) return;
    expect(resultado.precio).toBeUndefined();
  });
});

describe("construirPlanConRepeticiones", () => {
  it("repeticiones=1 delega en construirPlan (mismo resultado, tipo continuo)", () => {
    const solicitud = {
      fecha: FECHA_PRUEBA,
      horaInicioCandidata: "09:00",
      cantidadPersonas: 5,
      servicioId: SERVICIO_PRUEBA,
      contexto: crearContextoDiaVacio(),
    };
    const directo = construirPlan(solicitud);
    const resultado = construirPlanConRepeticiones(solicitud, 1);

    expect(resultado.tipo).toBe("continuo");
    if (resultado.tipo !== "continuo") return;
    expect(resultado.plan).toEqual(directo);
  });

  it("5 personas x2 repeticiones en dia vacio -> continuo: 2 heats consecutivos, una sola limpieza al final", () => {
    const resultado = construirPlanConRepeticiones(
      {
        fecha: FECHA_PRUEBA,
        horaInicioCandidata: "09:00",
        cantidadPersonas: 5,
        servicioId: SERVICIO_PRUEBA,
        contexto: crearContextoDiaVacio(),
      },
      2,
    );

    expect(resultado.tipo).toBe("continuo");
    if (resultado.tipo !== "continuo") return;
    expect(resultado.plan.cantidadLotes).toBe(1);
    expect(resultado.plan.lotes).toHaveLength(1);
    expect(
      resultado.plan.lotes[0]!.heats.map((h) => [h.horaInicio, h.horaFin, h.personasAsignadas]),
    ).toEqual([
      ["09:00", "09:15", 5],
      ["09:15", "09:30", 5],
    ]);
    expect(resultado.plan.horaFinActividadCliente).toBe("09:30");
    expect(resultado.plan.liberacionOperativa).toBe("09:45");
  });

  it("6 personas x2 repeticiones en dia vacio -> continuo: 4 heats de 3, una sola limpieza al final", () => {
    const resultado = construirPlanConRepeticiones(
      {
        fecha: FECHA_PRUEBA,
        horaInicioCandidata: "09:00",
        cantidadPersonas: 6,
        servicioId: SERVICIO_PRUEBA,
        contexto: crearContextoDiaVacio(),
      },
      2,
    );

    expect(resultado.tipo).toBe("continuo");
    if (resultado.tipo !== "continuo") return;
    expect(resultado.plan.lotes).toHaveLength(1);
    expect(
      resultado.plan.lotes[0]!.heats.map((h) => [h.horaInicio, h.horaFin, h.personasAsignadas]),
    ).toEqual([
      ["09:00", "09:15", 3],
      ["09:15", "09:30", 3],
      ["09:30", "09:45", 3],
      ["09:45", "10:00", 3],
    ]);
    expect(resultado.plan.horaFinActividadCliente).toBe("10:00");
    expect(resultado.plan.liberacionOperativa).toBe("10:15");
  });

  it("precio continuo = precio de una vuelta x2 (sin descuento)", () => {
    const tarifa = {
      servicioId: SERVICIO_PRUEBA,
      moneda: "CRC",
      precioPorPersonaGrupoPequeno: 100,
      precioPorPersonaGrupoGrande: 80,
      porcentajeDeposito: 50,
    };
    const resultado = construirPlanConRepeticiones(
      {
        fecha: FECHA_PRUEBA,
        horaInicioCandidata: "09:00",
        cantidadPersonas: 5,
        servicioId: SERVICIO_PRUEBA,
        contexto: { ...crearContextoDiaVacio(), tarifa },
      },
      2,
    );

    expect(resultado.tipo).toBe("continuo");
    if (resultado.tipo !== "continuo") return;
    // una vuelta de 5 personas a tarifa grupal (80) = 400; x2 repeticiones = 800.
    expect(resultado.plan.precio).toEqual({ moneda: "CRC", montoTotal: 800, montoDeposito: 400, montoSaldo: 400 });
  });

  it("si la 2a vuelta no cabe justo despues, pero la 1a si -> requiere horario separado (cada vuelta con su propia limpieza)", () => {
    // 6 personas necesita 2 heats por vuelta (3+3). Bloqueamos el segundo heat
    // de la 2a vuelta (09:45), que queda FUERA del rango que usaria la 1a
    // vuelta sola (esta solo llega hasta su limpieza en 09:30-09:45).
    const contexto = conBloques(crearContextoDiaVacio(), [
      {
        tipo: "bloqueado",
        fecha: FECHA_PRUEBA,
        horaInicio: "09:45",
        horaFin: "10:00",
        idBloqueoAdministrativo: "bloqueo-1",
      },
    ]);

    const resultado = construirPlanConRepeticiones(
      {
        fecha: FECHA_PRUEBA,
        horaInicioCandidata: "09:00",
        cantidadPersonas: 6,
        servicioId: SERVICIO_PRUEBA,
        contexto,
      },
      2,
    );

    expect(resultado.tipo).toBe("requiere_horario_separado");
    if (resultado.tipo !== "requiere_horario_separado") return;
    expect(resultado.planPrimeraVuelta.lotes).toHaveLength(1);
    expect(
      resultado.planPrimeraVuelta.lotes[0]!.heats.map((h) => [h.horaInicio, h.horaFin, h.personasAsignadas]),
    ).toEqual([
      ["09:00", "09:15", 3],
      ["09:15", "09:30", 3],
    ]);
    expect(resultado.planPrimeraVuelta.horaFinActividadCliente).toBe("09:30");
    expect(resultado.planPrimeraVuelta.liberacionOperativa).toBe("09:45");
  });

  it("si ni siquiera la 1a vuelta cabe -> no_disponible", () => {
    // Igual que DISP-007: heat a las 11:45 con 5 personas cruza almuerzo (12:00) para la limpieza.
    const resultado = construirPlanConRepeticiones(
      {
        fecha: FECHA_PRUEBA,
        horaInicioCandidata: "11:45",
        cantidadPersonas: 5,
        servicioId: SERVICIO_PRUEBA,
        contexto: crearContextoDiaVacio(),
      },
      2,
    );

    expect(resultado.tipo).toBe("no_disponible");
    if (resultado.tipo !== "no_disponible") return;
    expect(resultado.motivo).toBe("CRUCE_CON_BLOQUE_NO_DISPONIBLE");
  });
});

describe("normalizarLoteTrasLiberacion", () => {
  function heat(
    heatId: string,
    posicionEnLote: number,
    horaInicio: HoraISO,
    quedaVacio: boolean,
  ): HeatParaNormalizar {
    return {
      heatId,
      posicionEnLote,
      horaInicio,
      horaFin: minutosAHora(horaAMinutos(horaInicio) + 15),
      quedaVacio,
    };
  }

  it("9.20: heat que conserva participantes tras liberar -> sin cambios", () => {
    const resultado = normalizarLoteTrasLiberacion({
      loteId: "lote-1",
      heats: [heat("heat-1", 1, "14:00", false)], // conserva las 2 confirmadas
    });
    expect(resultado).toEqual({ accion: "sin_cambios" });
  });

  it("9.21: lote de 2 heats que quedan completamente vacios -> se elimina el lote", () => {
    const resultado = normalizarLoteTrasLiberacion({
      loteId: "lote-1",
      heats: [heat("heat-1", 1, "14:30", true), heat("heat-2", 2, "14:45", true)],
    });
    expect(resultado).toEqual({ accion: "eliminar_lote" });
  });

  it("6.7.8: un heat vacio entre dos ocupados permanece como parte del lote", () => {
    const resultado = normalizarLoteTrasLiberacion({
      loteId: "lote-1",
      heats: [
        heat("heat-1", 1, "10:00", false),
        heat("heat-2", 2, "10:15", true),
        heat("heat-3", 3, "10:30", false),
      ],
    });
    expect(resultado).toEqual({ accion: "sin_cambios" });
  });

  it("6.7.8: recorta solo los heats vacios del inicio y reposiciona (la limpieza no se mueve)", () => {
    const resultado = normalizarLoteTrasLiberacion({
      loteId: "lote-1",
      heats: [
        heat("heat-1", 1, "10:00", true),
        heat("heat-2", 2, "10:15", false),
        heat("heat-3", 3, "10:30", false),
      ],
    });
    expect(resultado).toEqual({
      accion: "recortar_lote",
      heatIdsAEliminar: ["heat-1"],
      heatsConservados: [
        { heatId: "heat-2", nuevaPosicionEnLote: 1 },
        { heatId: "heat-3", nuevaPosicionEnLote: 2 },
      ],
      horaInicio: "10:15",
      horaFinUltimoHeat: "10:45",
      horaInicioLimpieza: "10:45",
      horaFinLimpieza: "11:00",
      cantidadHeats: 2,
    });
  });

  it("6.7.8: recorta solo los heats vacios del final y desplaza la limpieza antes", () => {
    const resultado = normalizarLoteTrasLiberacion({
      loteId: "lote-1",
      heats: [
        heat("heat-1", 1, "10:00", false),
        heat("heat-2", 2, "10:15", false),
        heat("heat-3", 3, "10:30", true),
      ],
    });
    expect(resultado).toEqual({
      accion: "recortar_lote",
      heatIdsAEliminar: ["heat-3"],
      heatsConservados: [
        { heatId: "heat-1", nuevaPosicionEnLote: 1 },
        { heatId: "heat-2", nuevaPosicionEnLote: 2 },
      ],
      horaInicio: "10:00",
      horaFinUltimoHeat: "10:30",
      horaInicioLimpieza: "10:30",
      horaFinLimpieza: "10:45",
      cantidadHeats: 2,
    });
  });

  it("6.7.8: recorta heats vacios de ambos extremos a la vez", () => {
    const resultado = normalizarLoteTrasLiberacion({
      loteId: "lote-1",
      heats: [
        heat("heat-1", 1, "10:00", true),
        heat("heat-2", 2, "10:15", false),
        heat("heat-3", 3, "10:30", true),
      ],
    });
    expect(resultado).toEqual({
      accion: "recortar_lote",
      heatIdsAEliminar: ["heat-1", "heat-3"],
      heatsConservados: [{ heatId: "heat-2", nuevaPosicionEnLote: 1 }],
      horaInicio: "10:15",
      horaFinUltimoHeat: "10:30",
      horaInicioLimpieza: "10:30",
      horaFinLimpieza: "10:45",
      cantidadHeats: 1,
    });
  });
});
