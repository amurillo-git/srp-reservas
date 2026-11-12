import { describe, expect, it } from "vitest";
import { formatoHora12, formatoRangoHora12, horarioEnHoraActual, reservaEnHoraActual } from "./format";

describe("formatoHora12", () => {
  it("convierte horas de la manana a AM sin cero a la izquierda", () => {
    expect(formatoHora12("09:00")).toBe("9:00 AM");
    expect(formatoHora12("11:45")).toBe("11:45 AM");
  });

  it("convierte horas de la tarde a PM", () => {
    expect(formatoHora12("13:30")).toBe("1:30 PM");
    expect(formatoHora12("23:45")).toBe("11:45 PM");
  });

  it("medianoche es 12 AM y mediodia es 12 PM", () => {
    expect(formatoHora12("00:15")).toBe("12:15 AM");
    expect(formatoHora12("12:00")).toBe("12:00 PM");
    expect(formatoHora12("12:45")).toBe("12:45 PM");
  });

  it("deja intacto un valor vacio o que no es una hora", () => {
    expect(formatoHora12("")).toBe("");
    expect(formatoHora12("no-es-hora")).toBe("no-es-hora");
    expect(formatoHora12("25:00")).toBe("25:00");
  });
});

describe("formatoRangoHora12", () => {
  it("une inicio y fin en 12 horas", () => {
    expect(formatoRangoHora12("09:00", "09:30")).toBe("9:00 AM – 9:30 AM");
    expect(formatoRangoHora12("11:45", "12:15")).toBe("11:45 AM – 12:15 PM");
  });
});

describe("horarioEnHoraActual", () => {
  const ahora = new Date(2026, 10, 11, 11, 20); // 11:20 AM, hora local

  it("es verdadero si el horario empieza dentro de la hora de reloj en curso", () => {
    expect(horarioEnHoraActual({ horaInicio: "11:30", horaFin: "11:45" }, ahora)).toBe(true);
    expect(horarioEnHoraActual({ horaInicio: "11:00", horaFin: "11:15" }, ahora)).toBe(true);
  });

  it("es verdadero si el horario empezo antes pero sigue en curso dentro de esa hora", () => {
    expect(horarioEnHoraActual({ horaInicio: "10:45", horaFin: "11:15" }, ahora)).toBe(true);
  });

  it("es falso si termina antes de que empiece la hora en curso o empieza despues de que termine", () => {
    expect(horarioEnHoraActual({ horaInicio: "10:15", horaFin: "11:00" }, ahora)).toBe(false);
    expect(horarioEnHoraActual({ horaInicio: "12:00", horaFin: "12:15" }, ahora)).toBe(false);
  });
});

describe("reservaEnHoraActual", () => {
  const ahora = new Date(2026, 10, 11, 11, 20);

  it("marca una reserva de hoy con algun horario en la hora actual", () => {
    expect(
      reservaEnHoraActual({ fecha: "2026-11-11", horarios: [{ horaInicio: "11:15", horaFin: "11:45" }] }, ahora),
    ).toBe(true);
  });

  it("no marca reservas de otro dia aunque la hora coincida", () => {
    expect(
      reservaEnHoraActual({ fecha: "2026-11-12", horarios: [{ horaInicio: "11:15", horaFin: "11:45" }] }, ahora),
    ).toBe(false);
  });

  it("marca la reserva si cualquiera de sus vueltas separadas cae en la hora actual", () => {
    expect(
      reservaEnHoraActual(
        {
          fecha: "2026-11-11",
          horarios: [
            { horaInicio: "09:00", horaFin: "09:15" },
            { horaInicio: "11:30", horaFin: "11:45" },
          ],
        },
        ahora,
      ),
    ).toBe(true);
  });

  it("no marca reservas sin horarios (canceladas, expiradas)", () => {
    expect(reservaEnHoraActual({ fecha: "2026-11-11", horarios: [] }, ahora)).toBe(false);
  });
});
