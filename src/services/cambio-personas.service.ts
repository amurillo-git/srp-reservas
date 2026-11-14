// ============================================================================
// Cambio de cantidad de personas por el administrador, por encima del limite
// de 5 por heat (excepcion operativa: el parque puede poner mas karts en un
// heat aunque la regla sea 5).
//
// Al SUBIR la cantidad de una reserva ya confirmada (o con SINPE pendiente),
// el administrador elige:
//   - MISMO_SLOT: se conservan los heats actuales y el total nuevo se reparte
//     entre ellos. Sin tope y sin mirar a otras reservas del mismo heat.
//   - REPARTIR: se rearma toda la reserva desde su hora original con el motor
//     de disponibilidad (equitativo, heats seguidos). Solo si no choca con
//     otras reservas; si choca, solo queda MISMO_SLOT.
// La decision solo se pide si, quedandose en los mismos heats, alguno pasaria
// de CAPACIDAD_MAXIMA_POR_HEAT (contando a otras reservas del heat). Si todo
// cabe, se aplica directo como MISMO_SLOT.
//
// Una reserva de varias vueltas (repeticiones) conserva su estructura: cada
// vuelta recibe el total nuevo (mismo slot) o se divide por separado
// (repartir), y el precio es el de una vuelta por la cantidad de vueltas.
// Dinero: igual que reprogramarReserva (28): con el deposito ya pagado
// (CONFIRMADA) no se toca y la diferencia va al saldo; con SINPE pendiente se
// recalcula el deposito sobre el total nuevo.
// ============================================================================

import type { Prisma, PrismaClient } from "@prisma/client";
import {
  CAPACIDAD_MAXIMA_POR_HEAT,
  calcularPrecio,
  horaAMinutos,
  type FechaISO,
  type HoraISO,
  type PlanDisponible,
} from "../motor-disponibilidad/motor-disponibilidad.js";
import {
  calcularYBloquearPlanContinuoFinal,
  calcularYBloquearPlanFinal,
  ConflictoBloqueoInestable,
  construirPlanDesde,
  construirPlanRepetidoDesde,
  esViolacionUnica,
  persistirPlanParaReserva,
  RESTRICCION_HEAT_UNICO,
} from "./availability.service.js";
import { normalizarUnLote } from "./expiracion.service.js";

type Cliente = Prisma.TransactionClient;

export type ModoCambioPersonas = "MISMO_SLOT" | "REPARTIR";

export interface HeatResumen {
  readonly horaInicio: string;
  readonly horaFin: string;
  readonly personas: number;
}

export type MotivoRepartoNoDisponible = "CHOCA_CON_OTRAS_RESERVAS" | "ESTRUCTURA_NO_SOPORTADA";

export type OpcionRepartir =
  | { readonly disponible: true; readonly heats: readonly HeatResumen[] }
  | { readonly disponible: false; readonly motivo: MotivoRepartoNoDisponible };

export type ResultadoOpcionesCambioPersonas =
  | {
      readonly ok: true;
      /** true si, en los mismos heats, alguno pasaria de la capacidad normal. */
      readonly requiereDecision: boolean;
      readonly mismoSlot: readonly HeatResumen[];
      /** null si no hace falta decidir (no se calcula). */
      readonly repartir: OpcionRepartir | null;
      readonly moneda: string;
      readonly montoTotal: number;
      readonly montoSaldo: number;
    }
  | { readonly ok: false; readonly motivo: "NO_ENCONTRADA" | "ESTADO_INVALIDO" | "CANTIDAD_INVALIDA" };

export type ResultadoCambioPersonas =
  | { readonly ok: true; readonly modo: ModoCambioPersonas; readonly montoTotal: number; readonly montoSaldo: number }
  | {
      readonly ok: false;
      readonly motivo:
        | "NO_ENCONTRADA"
        | "ESTADO_INVALIDO"
        | "CANTIDAD_INVALIDA"
        | "DECISION_REQUERIDA"
        | "REPARTO_NO_DISPONIBLE"
        | "CONFLICTO_CONCURRENCIA";
    };

/** Solo reservas con compromiso real: igual que reprogramarReserva. */
const ESTADOS_MODIFICABLES = new Set(["CONFIRMADA", "PENDIENTE_VALIDACION_SINPE"]);

/** Reservas cuyas asignaciones ocupan lugar en un heat (6.5; PAGADA = ya
 * cobrada por completo, sigue ocupando). */
function ocupaLugar(reserva: { estado: string; expiraEn: Date | null }, ahora: Date): boolean {
  if (reserva.estado === "TEMPORAL") return reserva.expiraEn !== null && reserva.expiraEn > ahora;
  return ["CONFIRMADA", "PAGADA", "PENDIENTE_VALIDACION_SINPE"].includes(reserva.estado);
}

interface HeatDeReserva {
  readonly asignacionId: string;
  readonly heatId: string;
  readonly loteId: string;
  readonly horaInicio: HoraISO;
  readonly horaFin: HoraISO;
  /** Personas de OTRAS reservas que ocupan este heat. */
  readonly personasDeOtros: number;
}

/** Heats donde la reserva tiene asignacion activa, en orden cronologico. */
async function cargarHeatsDeReserva(cliente: Cliente, reservationId: string): Promise<HeatDeReserva[]> {
  const propias = await cliente.heatAllocation.findMany({ where: { reservationId, estado: "ACTIVA" } });
  if (propias.length === 0) return [];

  const heats = await cliente.heat.findMany({
    where: { id: { in: propias.map((a) => a.heatId) } },
    include: {
      asignaciones: {
        where: { estado: "ACTIVA" },
        include: { reservation: { select: { estado: true, expiraEn: true } } },
      },
    },
  });

  const ahora = new Date();
  const resultado: HeatDeReserva[] = [];
  for (const asignacion of propias) {
    const heat = heats.find((h) => h.id === asignacion.heatId);
    if (!heat) continue;
    const personasDeOtros = heat.asignaciones
      .filter((o) => o.reservationId !== reservationId && ocupaLugar(o.reservation, ahora))
      .reduce((suma, o) => suma + o.cantidadParticipantes, 0);
    resultado.push({
      asignacionId: asignacion.id,
      heatId: heat.id,
      loteId: heat.loteId,
      horaInicio: heat.horaInicio as HoraISO,
      horaFin: heat.horaFin as HoraISO,
      personasDeOtros,
    });
  }
  return resultado.sort((a, b) => a.horaInicio.localeCompare(b.horaInicio));
}

/** Vueltas que tiene la reserva segun sus heats: un heat por vuelta y por
 * grupo; si no cuadra (datos viejos), se trata como una sola vuelta. */
function vueltasDe(repeticiones: number | null | undefined, cantidadHeats: number): number {
  const vueltas = Math.max(1, repeticiones ?? 1);
  return cantidadHeats % vueltas === 0 ? vueltas : 1;
}

function repartirEquitativo(total: number, partes: number): number[] {
  const base = Math.floor(total / partes);
  const residuo = total % partes;
  return Array.from({ length: partes }, (_, i) => (i < residuo ? base + 1 : base));
}

/** Total nuevo repartido entre los heats que la reserva ya tiene: cada vuelta
 * (grupo consecutivo de heats) recibe el total completo, dividido entre sus heats. */
function distribucionMismoSlot(heatsCantidad: number, vueltas: number, total: number): number[] {
  const porVuelta = heatsCantidad / vueltas;
  return Array.from({ length: vueltas }, () => repartirEquitativo(total, porVuelta)).flat();
}

function redondear(valor: number): number {
  return Math.round(valor * 100) / 100;
}

interface Montos {
  readonly moneda: string;
  readonly montoTotal: number;
  readonly montoDeposito: number;
  readonly montoSaldo: number;
}

async function calcularMontos(
  cliente: Cliente,
  reserva: { servicioId: string; estado: string; montoDeposito: unknown },
  nuevaCantidad: number,
  vueltas: number,
): Promise<Montos | null> {
  const servicio = await cliente.service.findUnique({ where: { id: reserva.servicioId } });
  if (!servicio) return null;
  const unitario = calcularPrecio(
    {
      servicioId: servicio.id,
      moneda: servicio.moneda,
      precioPorPersonaGrupoPequeno: Number(servicio.precioPorPersonaGrupoPequeno),
      precioPorPersonaGrupoGrande: Number(servicio.precioPorPersonaGrupoGrande),
      porcentajeDeposito: servicio.porcentajeDeposito,
    },
    nuevaCantidad,
  );
  const montoTotal = redondear(unitario.montoTotal * vueltas);
  if (reserva.estado === "CONFIRMADA") {
    const montoDeposito = Number(reserva.montoDeposito);
    return { moneda: unitario.moneda, montoTotal, montoDeposito, montoSaldo: Math.max(0, redondear(montoTotal - montoDeposito)) };
  }
  const montoDeposito = redondear(unitario.montoDeposito * vueltas);
  return { moneda: unitario.moneda, montoTotal, montoDeposito, montoSaldo: redondear(montoTotal - montoDeposito) };
}

type ResultadoReparto =
  | { readonly ok: true; readonly planes: readonly PlanDisponible[] }
  | { readonly ok: false; readonly motivo: MotivoRepartoNoDisponible };

/** Rearma la reserva con el motor desde su(s) hora(s) original(es), sin
 * contar sus propias asignaciones. `bloquear` = dentro de la transaccion de
 * aplicar (con locks); sin bloquear = vista previa. Cada tramo (lote) se
 * rearma desde su propia hora, asi una reserva con vueltas en horarios
 * separados las mantiene separadas. */
async function planearReparto(
  cliente: Cliente,
  reserva: { id: string; servicioId: string; fecha: Date },
  heats: readonly HeatDeReserva[],
  nuevaCantidad: number,
  vueltas: number,
  bloquear: boolean,
): Promise<ResultadoReparto> {
  const fecha = reserva.fecha.toISOString().slice(0, 10) as FechaISO;

  const tramos: { inicio: HoraISO; vueltas: number }[] = [];
  if (vueltas === 1) {
    tramos.push({ inicio: heats[0]!.horaInicio, vueltas: 1 });
  } else {
    const porVuelta = heats.length / vueltas;
    const lotes = new Map<string, HeatDeReserva[]>();
    for (const heat of heats) lotes.set(heat.loteId, [...(lotes.get(heat.loteId) ?? []), heat]);
    for (const grupo of lotes.values()) {
      if (grupo.length % porVuelta !== 0) return { ok: false, motivo: "ESTRUCTURA_NO_SOPORTADA" };
      tramos.push({ inicio: grupo[0]!.horaInicio, vueltas: grupo.length / porVuelta });
    }
  }

  const planes: PlanDisponible[] = [];
  for (const tramo of tramos) {
    const solicitud = {
      servicioId: reserva.servicioId,
      fecha,
      horaInicioCandidata: tramo.inicio,
      cantidadPersonas: nuevaCantidad,
    };
    let plan: PlanDisponible | null = null;
    if (tramo.vueltas > 1) {
      if (bloquear) {
        const r = await calcularYBloquearPlanContinuoFinal(cliente, solicitud, tramo.vueltas, reserva.id);
        plan = r.disponible ? r.plan : null;
      } else {
        const r = await construirPlanRepetidoDesde(cliente, solicitud, tramo.vueltas, reserva.id);
        plan = r.tipo === "continuo" ? r.plan : null;
      }
    } else if (bloquear) {
      const r = await calcularYBloquearPlanFinal(cliente, solicitud, reserva.id);
      plan = r.disponible ? r.plan : null;
    } else {
      const r = await construirPlanDesde(cliente, solicitud, reserva.id);
      plan = r.disponible ? r : null;
    }
    if (!plan) return { ok: false, motivo: "CHOCA_CON_OTRAS_RESERVAS" };
    planes.push(plan);
  }

  // Los tramos se rearman por separado: que uno ampliado no se monte sobre el siguiente.
  for (let i = 1; i < planes.length; i++) {
    if (horaAMinutos(planes[i - 1]!.liberacionOperativa) > horaAMinutos(planes[i]!.lotes[0]!.horaInicio)) {
      return { ok: false, motivo: "CHOCA_CON_OTRAS_RESERVAS" };
    }
  }
  return { ok: true, planes };
}

function resumenDePlanes(planes: readonly PlanDisponible[]): HeatResumen[] {
  return planes.flatMap((plan) =>
    plan.lotes.flatMap((lote) =>
      lote.heats.map((h) => ({ horaInicio: h.horaInicio, horaFin: h.horaFin, personas: h.personasAsignadas })),
    ),
  );
}

type ReservaCambiable = NonNullable<Awaited<ReturnType<Cliente["reservation"]["findUnique"]>>>;

function validar(
  reserva: ReservaCambiable | null,
  nuevaCantidad: number,
): { ok: false; motivo: "NO_ENCONTRADA" | "ESTADO_INVALIDO" | "CANTIDAD_INVALIDA" } | null {
  if (!reserva) return { ok: false, motivo: "NO_ENCONTRADA" };
  if (!ESTADOS_MODIFICABLES.has(reserva.estado)) return { ok: false, motivo: "ESTADO_INVALIDO" };
  if (!Number.isInteger(nuevaCantidad) || nuevaCantidad <= reserva.cantidadPersonas) {
    return { ok: false, motivo: "CANTIDAD_INVALIDA" };
  }
  return null;
}

/**
 * Que opciones tiene el administrador al subir la cantidad de personas de una
 * reserva. Solo lectura: no bloquea ni cambia nada.
 */
export async function consultarOpcionesCambioPersonas(
  prisma: PrismaClient,
  codigoPublico: string,
  nuevaCantidad: number,
): Promise<ResultadoOpcionesCambioPersonas> {
  const reserva = await prisma.reservation.findUnique({ where: { codigoPublico } });
  const invalida = validar(reserva, nuevaCantidad);
  if (invalida || !reserva) return invalida ?? { ok: false, motivo: "NO_ENCONTRADA" };

  const heats = await cargarHeatsDeReserva(prisma, reserva.id);
  if (heats.length === 0) return { ok: false, motivo: "ESTADO_INVALIDO" };

  const vueltas = vueltasDe(reserva.repeticiones, heats.length);
  const distribucion = distribucionMismoSlot(heats.length, vueltas, nuevaCantidad);
  const requiereDecision = heats.some((h, i) => h.personasDeOtros + distribucion[i]! > CAPACIDAD_MAXIMA_POR_HEAT);

  const montos = await calcularMontos(prisma, reserva, nuevaCantidad, vueltas);
  if (!montos) return { ok: false, motivo: "NO_ENCONTRADA" };

  let repartir: OpcionRepartir | null = null;
  if (requiereDecision) {
    const reparto = await planearReparto(prisma, reserva, heats, nuevaCantidad, vueltas, false);
    repartir = reparto.ok
      ? { disponible: true, heats: resumenDePlanes(reparto.planes) }
      : { disponible: false, motivo: reparto.motivo };
  }

  return {
    ok: true,
    requiereDecision,
    mismoSlot: heats.map((h, i) => ({ horaInicio: h.horaInicio, horaFin: h.horaFin, personas: distribucion[i]! })),
    repartir,
    moneda: montos.moneda,
    montoTotal: montos.montoTotal,
    montoSaldo: montos.montoSaldo,
  };
}

/**
 * Aplica el cambio de cantidad de forma atomica. Si hace falta decidir y no se
 * indica `modo`, devuelve DECISION_REQUERIDA sin tocar nada. REPARTIR revalida
 * bajo lock y, si ya no cabe, devuelve REPARTO_NO_DISPONIBLE.
 */
export async function aplicarCambioPersonas(
  prisma: PrismaClient,
  codigoPublico: string,
  nuevaCantidad: number,
  modo?: ModoCambioPersonas,
  intentosMaximos = 3,
): Promise<ResultadoCambioPersonas> {
  if (!Number.isInteger(nuevaCantidad) || nuevaCantidad <= 0) return { ok: false, motivo: "CANTIDAD_INVALIDA" };

  for (let intento = 1; intento <= intentosMaximos; intento++) {
    try {
      return await prisma.$transaction(
        async (tx): Promise<ResultadoCambioPersonas> => {
          await tx.$queryRaw`SELECT id FROM "reservations" WHERE public_code = ${codigoPublico} FOR UPDATE`;
          const reserva = await tx.reservation.findUnique({ where: { codigoPublico } });
          const invalida = validar(reserva, nuevaCantidad);
          if (invalida || !reserva) return invalida ?? { ok: false, motivo: "NO_ENCONTRADA" };

          const heats = await cargarHeatsDeReserva(tx, reserva.id);
          if (heats.length === 0) return { ok: false, motivo: "ESTADO_INVALIDO" };

          const vueltas = vueltasDe(reserva.repeticiones, heats.length);
          const distribucion = distribucionMismoSlot(heats.length, vueltas, nuevaCantidad);
          const requiereDecision = heats.some(
            (h, i) => h.personasDeOtros + distribucion[i]! > CAPACIDAD_MAXIMA_POR_HEAT,
          );

          const modoFinal = modo ?? (requiereDecision ? null : "MISMO_SLOT");
          if (!modoFinal) return { ok: false, motivo: "DECISION_REQUERIDA" };

          const montos = await calcularMontos(tx, reserva, nuevaCantidad, vueltas);
          if (!montos) return { ok: false, motivo: "NO_ENCONTRADA" };

          if (modoFinal === "MISMO_SLOT") {
            for (let i = 0; i < heats.length; i++) {
              await tx.heatAllocation.update({
                where: { id: heats[i]!.asignacionId },
                data: { cantidadParticipantes: distribucion[i]! },
              });
            }
          } else {
            const reparto = await planearReparto(tx, reserva, heats, nuevaCantidad, vueltas, true);
            if (!reparto.ok) return { ok: false, motivo: "REPARTO_NO_DISPONIBLE" };

            const fecha = reserva.fecha.toISOString().slice(0, 10) as FechaISO;
            // Retener lo nuevo ANTES de liberar lo anterior (igual que reprogramar).
            for (const plan of reparto.planes) {
              await persistirPlanParaReserva(tx, reserva.servicioId, fecha, reserva.id, plan);
            }
            const ahora = new Date();
            for (const heat of heats) {
              await tx.heatAllocation.update({
                where: { id: heat.asignacionId },
                data: { estado: "LIBERADA", liberadoEn: ahora },
              });
            }
            for (const loteId of new Set(heats.map((h) => h.loteId))) {
              await normalizarUnLote(tx, loteId);
            }
          }

          await tx.reservation.update({
            where: { id: reserva.id },
            data: {
              cantidadPersonas: nuevaCantidad,
              moneda: montos.moneda,
              montoTotal: montos.montoTotal,
              montoDeposito: montos.montoDeposito,
              montoSaldo: montos.montoSaldo,
            },
          });

          return { ok: true, modo: modoFinal, montoTotal: montos.montoTotal, montoSaldo: montos.montoSaldo };
        },
        { maxWait: 5_000, timeout: 10_000 },
      );
    } catch (error) {
      const esConflictoDeCapacidad = esViolacionUnica(error, RESTRICCION_HEAT_UNICO);
      if (esConflictoDeCapacidad || error instanceof ConflictoBloqueoInestable) {
        if (intento < intentosMaximos) continue;
        return { ok: false, motivo: "CONFLICTO_CONCURRENCIA" };
      }
      throw error;
    }
  }
  return { ok: false, motivo: "CONFLICTO_CONCURRENCIA" };
}
