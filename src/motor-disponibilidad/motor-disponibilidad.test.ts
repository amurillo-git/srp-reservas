import { describe, expect, it } from "vitest";
import {
  construirPlan,
  horaAMinutos,
  minutosAHora,
  type BloqueDeCalendario,
  type ContextoDisponibilidad,
  type FechaISO,
  type HoraISO,
} from "./motor-disponibilidad.js";

// Casos de prueba prioritarios del motor de disponibilidad (seccion 24 de
// propuesta.md). Los casos DISP-001..004 y DISP-009 ya tienen asercion real
// (Etapa 2); el resto sigue como `it.todo` hasta implementarse.

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

  it.todo("DISP-005: heat con 2 personas y nueva reserva de 3 -> comparten el heat");
  it.todo(
    "DISP-006: heat con 2 personas y nueva reserva de 4 -> la hora no se ofrece; el grupo no cabe en un heat",
  );
  it.todo(
    "DISP-007: heat de 11:45 con almuerzo a las 12:00 -> no puede ser el ultimo heat de un lote porque la limpieza se cruza",
  );
  it.todo(
    "DISP-008: ocho personas desde 11:30 -> la hora no se ofrece porque el lote y su limpieza cruzan el almuerzo",
  );
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
  it.todo(
    "DISP-010: heat completo a las 10:00 y diez personas desde 9:30 -> la hora no se ofrece porque la limpieza del lote se cruza con el heat existente",
  );
  it.todo(
    "DISP-011: heat completo a las 10:00 y diez personas desde 9:15 -> dos heats y limpieza terminan exactamente a las 10:00",
  );
  it.todo("DISP-012: ultimo heat a las 3:30 -> permitido; limpieza termina a las 4:00");
  it.todo("DISP-013: diez personas desde las 3:15 -> dos heats y limpieza terminan a las 4:00");
  it.todo("DISP-014: quince personas desde las 3:00 -> tres heats y limpieza terminan a las 4:00");
  it.todo(
    "DISP-015: ampliar un lote de uno a dos heats -> se mueve la limpieza solo si el nuevo intervalo esta libre",
  );
  it.todo("DISP-016: reserva de 7 personas -> distribucion 4 + 3 o 3 + 4; nunca 5 + 2");
  it.todo("DISP-017: reserva de 11 personas -> distribucion 4 + 4 + 3 en cualquier orden compatible");
  it.todo("DISP-018: reserva de 14 personas -> distribucion 5 + 5 + 4 en cualquier orden compatible");
  it.todo(
    "DISP-019: dia vacio, grupo de 5 -> ofrece 9:00, 9:15, 9:30 y cada inicio valido hasta 11:30 antes del almuerzo",
  );
  it.todo(
    "DISP-020: dia vacio, grupo de 6 -> ofrece 9:00, 9:15, 9:30 y cada inicio valido hasta 11:15 antes del almuerzo",
  );
  it.todo(
    "DISP-021: grupo de 6 reservado a las 9:15; nueva solicitud de 5 -> no ofrece 9:00-9:45; el primer inicio libre es 10:00",
  );
});
