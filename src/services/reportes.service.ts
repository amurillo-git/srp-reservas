// ============================================================================
// Reportes administrativos de solo lectura (25).
//
// De los nueve reportes que pide propuesta.md 25, siete se construyen aqui
// con los datos que ya existen. Los otros dos NO se implementan porque el
// dato simplemente no existe todavia en el sistema (no es una omision, es
// una imposibilidad real con el esquema actual):
//   - "Cancelaciones y reprogramaciones": la parte de reprogramaciones se
//     cubre con el contador minimo `Reservation.vecesReprogramada` (25.8),
//     pero un historial completo (quien, cuando, de-donde-a-donde) requiere
//     Auditoria (seccion 21), fuera de alcance de este slice.
//   - "Clientes no presentados": no existe ningun estado ni accion de
//     "marcar no presentado" en el sistema (14.5-14.6 lo dejaron
//     explicitamente fuera de alcance). No hay nada que reportar todavia.
//
// Todos los reportes acotados por rango usan `fecha` (la fecha de la
// experiencia/heat), no la fecha en que se creo o confirmo el registro.
// ============================================================================

import type { EstadoReserva, PrismaClient } from "@prisma/client";
import { fechaISOaDate } from "./availability.service.js";
import { CAPACIDAD_MAXIMA_POR_HEAT, type FechaISO } from "../motor-disponibilidad/motor-disponibilidad.js";

function dateAFechaISO(fecha: Date): FechaISO {
  return fecha.toISOString().slice(0, 10) as FechaISO;
}

function rangoFechas(desde: FechaISO, hasta: FechaISO) {
  return { gte: fechaISOaDate(desde), lte: fechaISOaDate(hasta) };
}

export interface ConteoPorFechaYEstado {
  readonly fecha: FechaISO;
  readonly estado: string;
  readonly cantidad: number;
}

/** Reservas por fecha y estado (25): conteo agrupado, ordenado por fecha y
 * luego por estado. */
export async function reservasPorFechaYEstado(
  prisma: PrismaClient,
  servicioId: string,
  desde: FechaISO,
  hasta: FechaISO,
): Promise<readonly ConteoPorFechaYEstado[]> {
  const reservas = await prisma.reservation.findMany({
    where: { servicioId, fecha: rangoFechas(desde, hasta) },
  });

  const conteos = new Map<string, number>();
  for (const reserva of reservas) {
    const clave = `${dateAFechaISO(reserva.fecha)}|${reserva.estado}`;
    conteos.set(clave, (conteos.get(clave) ?? 0) + 1);
  }

  return Array.from(conteos.entries())
    .map(([clave, cantidad]) => {
      const [fecha, estado] = clave.split("|") as [FechaISO, string];
      return { fecha, estado, cantidad };
    })
    .sort((a, b) => a.fecha.localeCompare(b.fecha) || a.estado.localeCompare(b.estado));
}

export interface ParticipantesDelDia {
  readonly fecha: FechaISO;
  readonly totalParticipantes: number;
}

/** Participantes por dia (25): suma cantidadParticipantes de asignaciones
 * ACTIVAS (ocupacion real, igual criterio que availability.service.ts), no
 * la cantidadPersonas de la reserva (que no refleja liberaciones parciales). */
export async function participantesPorDia(
  prisma: PrismaClient,
  servicioId: string,
  desde: FechaISO,
  hasta: FechaISO,
): Promise<readonly ParticipantesDelDia[]> {
  const heats = await prisma.heat.findMany({
    where: { servicioId, fecha: rangoFechas(desde, hasta) },
    include: { asignaciones: { where: { estado: "ACTIVA" } } },
  });

  const totales = new Map<FechaISO, number>();
  for (const heat of heats) {
    const fecha = dateAFechaISO(heat.fecha);
    const participantesDelHeat = heat.asignaciones.reduce(
      (suma: number, asignacion: { cantidadParticipantes: number }) => suma + asignacion.cantidadParticipantes,
      0,
    );
    totales.set(fecha, (totales.get(fecha) ?? 0) + participantesDelHeat);
  }

  return Array.from(totales.entries())
    .map(([fecha, totalParticipantes]) => ({ fecha, totalParticipantes }))
    .sort((a, b) => a.fecha.localeCompare(b.fecha));
}

export interface OcupacionHeat {
  readonly heatId: string;
  readonly horaInicio: string;
  readonly capacidadMaxima: number;
  readonly ocupados: number;
  readonly disponible: number;
}

/** Ocupacion de heats y capacidad libre (25) para un dia puntual: por cada
 * heat activo, cuantos participantes tiene y cuanto cupo queda. */
export async function ocupacionHeatsDelDia(
  prisma: PrismaClient,
  servicioId: string,
  fecha: FechaISO,
): Promise<readonly OcupacionHeat[]> {
  const heats = await prisma.heat.findMany({
    where: { servicioId, fecha: fechaISOaDate(fecha) },
    orderBy: { horaInicio: "asc" },
    include: { asignaciones: { where: { estado: "ACTIVA" } } },
  });

  return heats.map((heat: { id: string; horaInicio: string; asignaciones: { cantidadParticipantes: number }[] }) => {
    const ocupados = heat.asignaciones.reduce((suma, asignacion) => suma + asignacion.cantidadParticipantes, 0);
    return {
      heatId: heat.id,
      horaInicio: heat.horaInicio,
      capacidadMaxima: CAPACIDAD_MAXIMA_POR_HEAT,
      ocupados,
      disponible: CAPACIDAD_MAXIMA_POR_HEAT - ocupados,
    };
  });
}

export type MetodoPago = "SINPE" | "TARJETA";

export interface DepositoPorMetodo {
  readonly metodo: MetodoPago;
  readonly totalDepositos: number;
  readonly cantidadReservas: number;
}

/** Depositos por metodo de pago (25): solo reservas CONFIRMADA (deposito
 * efectivamente cobrado). El metodo se infiere de `pagoTarjetaSesionId`
 * porque hoy CONFIRMADA solo se alcanza por esas dos vias (6.9, 6.8). */
export async function depositosPorMetodoPago(
  prisma: PrismaClient,
  servicioId: string,
  desde: FechaISO,
  hasta: FechaISO,
): Promise<readonly DepositoPorMetodo[]> {
  const reservas = await prisma.reservation.findMany({
    where: { servicioId, estado: "CONFIRMADA", fecha: rangoFechas(desde, hasta) },
  });

  const totales = new Map<MetodoPago, { totalDepositos: number; cantidadReservas: number }>();
  for (const reserva of reservas) {
    const metodo: MetodoPago = reserva.pagoTarjetaSesionId ? "TARJETA" : "SINPE";
    const acumulado = totales.get(metodo) ?? { totalDepositos: 0, cantidadReservas: 0 };
    totales.set(metodo, {
      totalDepositos: acumulado.totalDepositos + Number(reserva.montoDeposito),
      cantidadReservas: acumulado.cantidadReservas + 1,
    });
  }

  return Array.from(totales.entries())
    .map(([metodo, valores]) => ({ metodo, ...valores }))
    .sort((a, b) => a.metodo.localeCompare(b.metodo));
}

export interface ReservaResumen {
  readonly codigoPublico: string;
  readonly fecha: FechaISO;
  readonly cantidadPersonas: number;
  readonly clienteNombre: string;
  readonly clienteTelefono: string;
}

export interface FiltrosBusquedaReservas {
  /** Texto libre: coincide con codigoPublico, clienteNombre o clienteTelefono. */
  readonly q?: string;
  readonly estado?: EstadoReserva;
  readonly desde?: FechaISO;
  readonly hasta?: FechaISO;
}

export interface ReservaBusqueda extends ReservaResumen {
  readonly estado: string;
  readonly vecesReprogramada: number;
  /** 25: para que el panel pueda mostrar/gatillar "Cobrar saldo" sin una
   * segunda consulta. */
  readonly montoSaldo: number;
  readonly moneda: string;
}

/** Tope duro de resultados (14.5): esta pantalla es para encontrar UNA
 * reserva puntual, no para exportar la tabla completa; sin filtros (o con
 * filtros muy amplios) simplemente se corta aqui en vez de traer todo. */
const LIMITE_RESULTADOS_BUSQUEDA = 100;

/** Busqueda de reservas para el panel administrativo (14.5): combina texto
 * libre (codigo/nombre/telefono), estado y rango de fecha, todos opcionales.
 * Sin ningun filtro, devuelve las mas recientes del servicio (topadas por
 * LIMITE_RESULTADOS_BUSQUEDA) para que la pantalla nunca quede vacia sin
 * explicacion. */
export async function buscarReservas(
  prisma: PrismaClient,
  servicioId: string,
  filtros: FiltrosBusquedaReservas,
): Promise<readonly ReservaBusqueda[]> {
  const texto = filtros.q?.trim();
  const fecha: { gte?: Date; lte?: Date } = {};
  if (filtros.desde) fecha.gte = fechaISOaDate(filtros.desde);
  if (filtros.hasta) fecha.lte = fechaISOaDate(filtros.hasta);

  const reservas = await prisma.reservation.findMany({
    where: {
      servicioId,
      ...(filtros.estado ? { estado: filtros.estado } : {}),
      ...(fecha.gte || fecha.lte ? { fecha } : {}),
      ...(texto
        ? {
            OR: [
              { codigoPublico: { contains: texto, mode: "insensitive" as const } },
              { clienteNombre: { contains: texto, mode: "insensitive" as const } },
              { clienteTelefono: { contains: texto } },
            ],
          }
        : {}),
    },
    orderBy: { fecha: "desc" },
    take: LIMITE_RESULTADOS_BUSQUEDA,
  });

  return reservas.map((reserva) => ({
    ...comoResumen(reserva),
    estado: reserva.estado,
    vecesReprogramada: reserva.vecesReprogramada ?? 0,
    montoSaldo: Number(reserva.montoSaldo),
    moneda: reserva.moneda,
  }));
}

function comoResumen(reserva: {
  codigoPublico: string;
  fecha: Date;
  cantidadPersonas: number;
  clienteNombre: string;
  clienteTelefono: string;
}): ReservaResumen {
  return {
    codigoPublico: reserva.codigoPublico,
    fecha: dateAFechaISO(reserva.fecha),
    cantidadPersonas: reserva.cantidadPersonas,
    clienteNombre: reserva.clienteNombre,
    clienteTelefono: reserva.clienteTelefono,
  };
}

export interface ReservaDelDia extends ReservaResumen {
  readonly estado: string;
}

/** Reservas del dia (14.1, dashboard admin): todas las reservas de la
 * fecha dada, sin filtrar por estado (el panel decide como distinguirlas
 * visualmente). */
export async function reservasDelDia(
  prisma: PrismaClient,
  servicioId: string,
  fecha: FechaISO,
): Promise<readonly ReservaDelDia[]> {
  const reservas = await prisma.reservation.findMany({
    where: { servicioId, fecha: rangoFechas(fecha, fecha) },
  });
  return reservas.map((reserva) => ({ ...comoResumen(reserva), estado: reserva.estado }));
}

/** SINPE pendientes (25): foto del momento, no se acota por fecha porque
 * son depositos que siguen esperando validacion HOY, sin importar cuando
 * sea la experiencia. */
export async function sinpePendientes(prisma: PrismaClient, servicioId: string): Promise<readonly ReservaResumen[]> {
  const reservas = await prisma.reservation.findMany({
    where: { servicioId, estado: "PENDIENTE_VALIDACION_SINPE" },
    orderBy: { fecha: "asc" },
  });
  return reservas.map(comoResumen);
}

/** Reservas vencidas (25): las que el worker de expiracion marco EXPIRADA
 * dentro del rango. */
export async function reservasVencidas(
  prisma: PrismaClient,
  servicioId: string,
  desde: FechaISO,
  hasta: FechaISO,
): Promise<readonly ReservaResumen[]> {
  const reservas = await prisma.reservation.findMany({
    where: { servicioId, estado: "EXPIRADA", fecha: rangoFechas(desde, hasta) },
    orderBy: { fecha: "asc" },
  });
  return reservas.map(comoResumen);
}

export interface CancelacionesYReprogramaciones {
  readonly cancelaciones: number;
  readonly reprogramaciones: number;
}

/** Cancelaciones y reprogramaciones (25): cancelaciones = conteo de
 * reservas CANCELADA; reprogramaciones = suma de `vecesReprogramada` de
 * TODAS las reservas del rango (sin importar su estado actual), ya que el
 * contador no distingue si la reserva reprogramada sigue vigente. Ver la
 * nota de alcance al inicio del archivo sobre por que no hay un historial
 * detallado (quien/cuando/de-donde-a-donde). */
export async function cancelacionesYReprogramaciones(
  prisma: PrismaClient,
  servicioId: string,
  desde: FechaISO,
  hasta: FechaISO,
): Promise<CancelacionesYReprogramaciones> {
  const reservas = await prisma.reservation.findMany({
    where: { servicioId, fecha: rangoFechas(desde, hasta) },
  });

  let cancelaciones = 0;
  let reprogramaciones = 0;
  for (const reserva of reservas) {
    if (reserva.estado === "CANCELADA") cancelaciones += 1;
    reprogramaciones += reserva.vecesReprogramada ?? 0;
  }
  return { cancelaciones, reprogramaciones };
}
