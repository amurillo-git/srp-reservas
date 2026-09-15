// ============================================================================
// Servicio de gestion de horarios desde el panel administrativo (14.3).
//
// Dos piezas ya existentes en el schema, sin API de escritura hasta ahora:
// - ScheduleTemplate: horario semanal habitual (un renglon por dia 0-6).
// - ScheduleException: excepcion puntual para una fecha (HABILITADO,
//   MODIFICADO o CERRADO), con prioridad sobre la plantilla ese dia.
// Ambas ya son leidas por availability.service.ts (resolverVentanasDelDia);
// este archivo NO cambia esa logica, solo agrega como escribirlas.
//
// "Aplicar cambios futuros sin alterar reservas historicas" (14.3) no
// requiere logica extra: ScheduleTemplate/ScheduleException son configuracion
// de horario, independientes de las reservas ya persistidas (Heat,
// OperationalBatch, Reservation) — cambiarlas no toca esas filas.
// ============================================================================

import type { PrismaClient } from "@prisma/client";
import { fechaISOaDate } from "./availability.service.js";
import { horaAMinutos, type FechaISO, type HoraISO, type IdServicio } from "../motor-disponibilidad/motor-disponibilidad.js";

type ResultadoValidacion = { readonly ok: true } | { readonly ok: false; readonly motivo: string };

/** Valida una ventana horaria (apertura/cierre) y, si se da, un almuerzo
 * dentro de ella. Compartida entre la plantilla semanal y las excepciones:
 * ambas aceptan exactamente la misma forma de horario (6.2). */
function validarVentana(
  horaApertura: HoraISO,
  horaCierre: HoraISO,
  almuerzoInicio?: HoraISO,
  almuerzoFin?: HoraISO,
): ResultadoValidacion {
  if (horaAMinutos(horaApertura) >= horaAMinutos(horaCierre)) {
    return { ok: false, motivo: "horaApertura debe ser anterior a horaCierre" };
  }
  const tieneInicio = almuerzoInicio !== undefined;
  const tieneFin = almuerzoFin !== undefined;
  if (tieneInicio !== tieneFin) {
    return { ok: false, motivo: "almuerzoInicio y almuerzoFin deben especificarse juntos" };
  }
  if (tieneInicio && tieneFin) {
    if (horaAMinutos(almuerzoInicio) >= horaAMinutos(almuerzoFin)) {
      return { ok: false, motivo: "almuerzoInicio debe ser anterior a almuerzoFin" };
    }
    if (horaAMinutos(almuerzoInicio) < horaAMinutos(horaApertura) || horaAMinutos(almuerzoFin) > horaAMinutos(horaCierre)) {
      return { ok: false, motivo: "el almuerzo debe estar dentro del horario de apertura y cierre" };
    }
  }
  return { ok: true };
}

// ----------------------------------------------------------------------------
// Plantilla semanal.
// ----------------------------------------------------------------------------

export interface DatosPlantillaSemanal {
  readonly horaApertura: HoraISO;
  readonly horaCierre: HoraISO;
  readonly almuerzoInicio?: HoraISO;
  readonly almuerzoFin?: HoraISO;
  /** Default true; en false, ese dia de semana queda cerrado (6.4). */
  readonly activo?: boolean;
}

export interface PlantillaSemanalPublica {
  readonly diaSemana: number;
  readonly horaApertura: HoraISO;
  readonly horaCierre: HoraISO;
  readonly almuerzoInicio: HoraISO | null;
  readonly almuerzoFin: HoraISO | null;
  readonly activo: boolean;
}

export type ResultadoPlantillaSemanal =
  | { readonly ok: true; readonly plantilla: PlantillaSemanalPublica }
  | { readonly ok: false; readonly motivo: string };

function aPlantillaPublica(p: {
  diaSemana: number;
  horaApertura: string;
  horaCierre: string;
  almuerzoInicio: string | null;
  almuerzoFin: string | null;
  activo: boolean;
}): PlantillaSemanalPublica {
  return {
    diaSemana: p.diaSemana,
    horaApertura: p.horaApertura as HoraISO,
    horaCierre: p.horaCierre as HoraISO,
    almuerzoInicio: p.almuerzoInicio as HoraISO | null,
    almuerzoFin: p.almuerzoFin as HoraISO | null,
    activo: p.activo,
  };
}

/** Crea o reemplaza (upsert) el horario habitual de un dia de semana (6.2). */
export async function establecerPlantillaSemanal(
  prisma: PrismaClient,
  servicioId: IdServicio,
  diaSemana: number,
  datos: DatosPlantillaSemanal,
): Promise<ResultadoPlantillaSemanal> {
  if (!Number.isInteger(diaSemana) || diaSemana < 0 || diaSemana > 6) {
    return { ok: false, motivo: "diaSemana debe ser un entero entre 0 (domingo) y 6 (sabado)" };
  }
  const validacion = validarVentana(datos.horaApertura, datos.horaCierre, datos.almuerzoInicio, datos.almuerzoFin);
  if (!validacion.ok) return validacion;

  const campos = {
    horaApertura: datos.horaApertura,
    horaCierre: datos.horaCierre,
    almuerzoInicio: datos.almuerzoInicio ?? null,
    almuerzoFin: datos.almuerzoFin ?? null,
    activo: datos.activo ?? true,
  };
  const plantilla = await prisma.scheduleTemplate.upsert({
    where: { servicioId_diaSemana: { servicioId, diaSemana } },
    create: { servicioId, diaSemana, ...campos },
    update: campos,
  });
  return { ok: true, plantilla: aPlantillaPublica(plantilla) };
}

export async function listarPlantillaSemanal(
  prisma: PrismaClient,
  servicioId: IdServicio,
): Promise<readonly PlantillaSemanalPublica[]> {
  const plantillas = await prisma.scheduleTemplate.findMany({
    where: { servicioId },
    orderBy: { diaSemana: "asc" },
  });
  return plantillas.map(aPlantillaPublica);
}

// ----------------------------------------------------------------------------
// Excepciones de calendario.
// ----------------------------------------------------------------------------

export type TipoExcepcion = "HABILITADO" | "MODIFICADO" | "CERRADO";

export interface DatosExcepcion {
  readonly fecha: FechaISO;
  readonly tipo: TipoExcepcion;
  readonly horaApertura?: HoraISO;
  readonly horaCierre?: HoraISO;
  readonly almuerzoInicio?: HoraISO;
  readonly almuerzoFin?: HoraISO;
  readonly motivo?: string;
}

export interface ExcepcionPublica {
  readonly id: string;
  readonly fecha: FechaISO;
  readonly tipo: TipoExcepcion;
  readonly horaApertura: HoraISO | null;
  readonly horaCierre: HoraISO | null;
  readonly almuerzoInicio: HoraISO | null;
  readonly almuerzoFin: HoraISO | null;
  readonly motivo: string | null;
}

export type ResultadoCrearExcepcion =
  | { readonly ok: true; readonly excepcionId: string }
  | { readonly ok: false; readonly motivo: string };

function dateAFechaISO(fecha: Date): FechaISO {
  return fecha.toISOString().slice(0, 10) as FechaISO;
}

/**
 * Crea una excepcion de calendario para una fecha puntual (6.2, 14.3):
 * habilita una fecha normalmente cerrada, cierra una normalmente abierta, o
 * establece un horario distinto (incluye extender el horario de un feriado).
 * `CERRADO` no admite horas (no hay ventana que describir); `HABILITADO` y
 * `MODIFICADO` las requieren y se validan igual que la plantilla semanal.
 */
export async function crearExcepcion(
  prisma: PrismaClient,
  servicioId: IdServicio,
  datos: DatosExcepcion,
): Promise<ResultadoCrearExcepcion> {
  if (datos.tipo === "CERRADO") {
    if (datos.horaApertura || datos.horaCierre || datos.almuerzoInicio || datos.almuerzoFin) {
      return { ok: false, motivo: "una excepcion CERRADO no debe incluir horas" };
    }
  } else {
    if (!datos.horaApertura || !datos.horaCierre) {
      return { ok: false, motivo: "horaApertura y horaCierre son requeridos para HABILITADO/MODIFICADO" };
    }
    const validacion = validarVentana(datos.horaApertura, datos.horaCierre, datos.almuerzoInicio, datos.almuerzoFin);
    if (!validacion.ok) return validacion;
  }

  const excepcion = await prisma.scheduleException.create({
    data: {
      servicioId,
      fecha: fechaISOaDate(datos.fecha),
      tipo: datos.tipo,
      horaApertura: datos.horaApertura ?? null,
      horaCierre: datos.horaCierre ?? null,
      almuerzoInicio: datos.almuerzoInicio ?? null,
      almuerzoFin: datos.almuerzoFin ?? null,
      motivo: datos.motivo,
    },
  });
  return { ok: true, excepcionId: excepcion.id };
}

/** Excepciones de un servicio dentro de un mes ("YYYY-MM"), para la vista de
 * calendario del panel administrativo. */
export async function listarExcepciones(
  prisma: PrismaClient,
  servicioId: IdServicio,
  anioMes: string,
): Promise<readonly ExcepcionPublica[]> {
  const [anio, mes] = anioMes.split("-").map(Number) as [number, number];
  const inicio = new Date(Date.UTC(anio, mes - 1, 1));
  const finExclusivo = new Date(Date.UTC(anio, mes, 1));

  const excepciones = await prisma.scheduleException.findMany({
    where: { servicioId, fecha: { gte: inicio, lt: finExclusivo } },
  });
  return excepciones.map((e) => ({
    id: e.id,
    fecha: dateAFechaISO(e.fecha),
    tipo: e.tipo as TipoExcepcion,
    horaApertura: e.horaApertura as HoraISO | null,
    horaCierre: e.horaCierre as HoraISO | null,
    almuerzoInicio: e.almuerzoInicio as HoraISO | null,
    almuerzoFin: e.almuerzoFin as HoraISO | null,
    motivo: e.motivo ?? null,
  }));
}

export type ResultadoEliminarExcepcion = { readonly ok: true } | { readonly ok: false; readonly motivo: "NO_ENCONTRADA" };

export async function eliminarExcepcion(prisma: PrismaClient, id: string): Promise<ResultadoEliminarExcepcion> {
  try {
    await prisma.scheduleException.delete({ where: { id } });
    return { ok: true };
  } catch {
    return { ok: false, motivo: "NO_ENCONTRADA" };
  }
}
