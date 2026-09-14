import { describe, expect, it } from "vitest";
import { FakePrisma } from "./fake-prisma.js";

// Pruebas del doble de Prisma en si mismo (no de availability.service.ts):
// verifican que `heat.findMany` LEE los argumentos reales (`include`/`where`)
// en vez de asumir siempre la forma exacta que availability.service.ts pasa
// hoy (ver comentario de `heat.findMany` en fake-prisma.ts).

const SERVICIO_ID = "svc-1";
const FECHA_DATE = new Date("2026-09-13T00:00:00.000Z");

function fixture(): { fake: FakePrisma; heatId: string } {
  const fake = new FakePrisma();
  const lote = fake.crearLote({
    id: "lote-1", servicioId: SERVICIO_ID, fecha: FECHA_DATE,
    horaInicio: "09:00", horaFinUltimoHeat: "09:15",
    horaInicioLimpieza: "09:15", horaFinLimpieza: "09:30", cantidadHeats: 1,
  });
  const heat = fake.crearHeat({
    id: "heat-1", loteId: lote.id, servicioId: SERVICIO_ID, fecha: FECHA_DATE,
    horaInicio: "09:00", horaFin: "09:15", posicionEnLote: 1,
  });
  fake.crearReservaConAsignacion({
    heatId: heat.id, servicioId: SERVICIO_ID, fecha: FECHA_DATE,
    cantidadParticipantes: 2, estado: "CONFIRMADA",
  });
  return { fake, heatId: heat.id };
}

describe("FakePrisma.heat.findMany", () => {
  it("sin `include`, no agrega `lote` ni `asignaciones` a las filas devueltas", async () => {
    const { fake } = fixture();

    const filas = await fake.heat.findMany({ where: { servicioId: SERVICIO_ID, fecha: FECHA_DATE } });

    expect(filas).toHaveLength(1);
    expect("lote" in filas[0]!).toBe(false);
    expect("asignaciones" in filas[0]!).toBe(false);
  });

  it("respeta el `where` de `include.asignaciones` en vez de asumir siempre estado ACTIVA", async () => {
    const { fake, heatId } = fixture();
    // Libera la asignacion existente para poder distinguir un filtro real de
    // uno hardcodeado: si el fake siguiera asumiendo "ACTIVA" a pesar de que
    // se le pide "LIBERADA", esta consulta devolveria 0 asignaciones.
    fake.asignaciones[0]!.estado = "LIBERADA";

    const filasActivas = await fake.heat.findMany({
      where: { servicioId: SERVICIO_ID, fecha: FECHA_DATE },
      include: { asignaciones: { where: { estado: "ACTIVA" } } },
    });
    const filasLiberadas = await fake.heat.findMany({
      where: { servicioId: SERVICIO_ID, fecha: FECHA_DATE },
      include: { asignaciones: { where: { estado: "LIBERADA" } } },
    });

    expect((filasActivas[0] as { asignaciones: unknown[] }).asignaciones).toHaveLength(0);
    expect((filasLiberadas[0] as { asignaciones: unknown[] }).asignaciones).toHaveLength(1);
    expect(heatId).toBe("heat-1");
  });

  it("respeta el `select` de `include.asignaciones.include.reservation` en vez de siempre exponer {estado, expiraEn}", async () => {
    const { fake } = fixture();

    const filas = await fake.heat.findMany({
      where: { servicioId: SERVICIO_ID, fecha: FECHA_DATE },
      include: {
        asignaciones: {
          where: { estado: "ACTIVA" },
          include: { reservation: { select: { estado: true } } },
        },
      },
    });

    const asignacion = (filas[0] as { asignaciones: { reservation: Record<string, unknown> }[] })
      .asignaciones[0]!;
    expect(asignacion.reservation).toEqual({ estado: "CONFIRMADA" });
    expect("expiraEn" in asignacion.reservation).toBe(false);
  });
});
