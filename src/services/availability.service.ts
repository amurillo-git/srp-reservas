// ============================================================================
// Servicio de disponibilidad — capa de integracion Prisma/PostgreSQL.
//
// Orquesta la lectura/escritura de base de datos alrededor del motor puro
// `construirPlan` (../motor-disponibilidad/motor-disponibilidad). Este archivo
// NO reimplementa el algoritmo de busqueda de plan: solo construye el
// `ContextoDisponibilidad` desde Prisma, invoca al motor y persiste el
// resultado.
//
// Estrategia de bloqueo para la revalidacion (8.8): SELECT ... FOR UPDATE
// explicito (via $queryRaw) sobre los Heat/OperationalBatch EXISTENTES que el
// plan reutiliza, extendiendo el conjunto bloqueado hasta un punto fijo (ver
// `calcularYBloquearPlanFinal`) en vez de bloquear una sola vez con datos que
// ya podrian estar obsoletos. Los heats nuevos quedan protegidos por el
// indice unico (servicioId, fecha, horaInicio); un choque ahi se traduce en
// reintento acotado o conflicto explicito (8.8.6). Se eligio esta estrategia
// -y no Serializable+retry ni version optimista- porque 8.8 pide
// explicitamente bloquear "los heats involucrados": un lock dirigido a un
// subconjunto de filas conocido, no un aislamiento global.
// ============================================================================

import { Prisma, PrismaClient } from "@prisma/client";
import {
  construirPlan,
  horaAMinutos,
  minutosAHora,
  type BloqueDeCalendario,
  type ContextoDisponibilidad,
  type FechaISO,
  type HoraISO,
  type IdServicio,
  type LotePropuesto,
  type PlanDisponibilidad,
  type PlanDisponible,
  type PlanNoDisponible,
} from "../motor-disponibilidad/motor-disponibilidad.js";

type ClientePrisma = PrismaClient | Prisma.TransactionClient;

export interface SolicitudConsultarDisponibilidad {
  readonly servicioId: IdServicio;
  readonly fecha: FechaISO;
  readonly horaInicioCandidata: HoraISO;
  readonly cantidadPersonas: number;
}

export interface DatosClienteReserva {
  readonly nombre: string;
  readonly telefono: string;
  readonly email?: string;
}

export interface SolicitudConfirmarReserva extends SolicitudConsultarDisponibilidad {
  readonly cliente: DatosClienteReserva;
  /** 8.8.7: evita que un doble clic / reintento de red cree dos reservas. */
  readonly claveIdempotencia: string;
}

// ----------------------------------------------------------------------------
// Vistas publicas del plan: nunca exponen la limpieza al cliente.
// ----------------------------------------------------------------------------
// El motor puro necesita `horaFinLimpieza` (por lote) y `liberacionOperativa`
// (global) para razonar sobre disponibilidad y para que este servicio pueda
// persistir OperationalBatch correctamente. Pero el blueprint es explicito:
// la limpieza se usa para validar disponibilidad y JAMAS se muestra como
// parte de la actividad del cliente (glosario "Fin de actividad del
// cliente"; 8.7). Por eso todo lo que sale de este servicio hacia quien lo
// llame pasa por `ocultarLimpieza`/`aResultadoPublico`, que quitan esos
// campos antes de retornar.

export type LotePropuestoPublico = Omit<LotePropuesto, "horaFinLimpieza">;

export type PlanDisponiblePublico = Omit<PlanDisponible, "lotes" | "liberacionOperativa"> & {
  readonly lotes: readonly LotePropuestoPublico[];
};

export type PlanDisponibilidadPublico = PlanDisponiblePublico | PlanNoDisponible;

function ocultarLimpiezaDelLote(lote: LotePropuesto): LotePropuestoPublico {
  const { horaFinLimpieza: _horaFinLimpieza, ...resto } = lote;
  return resto;
}

/** Quita `liberacionOperativa` y el `horaFinLimpieza` de cada lote antes de
 * devolver un plan disponible a quien llamo al servicio. */
export function ocultarLimpieza(plan: PlanDisponible): PlanDisponiblePublico {
  const { liberacionOperativa: _liberacionOperativa, lotes, ...resto } = plan;
  return { ...resto, lotes: lotes.map(ocultarLimpiezaDelLote) };
}

/** Version de `ocultarLimpieza` para el resultado completo de `construirPlan`
 * (disponible o no); un `PlanNoDisponible` no tiene nada que ocultar. */
function aResultadoPublico(plan: PlanDisponibilidad): PlanDisponibilidadPublico {
  return plan.disponible ? ocultarLimpieza(plan) : plan;
}

export type ResultadoConfirmacion =
  | { readonly exito: true; readonly idReserva: string; readonly codigoPublico: string; readonly plan: PlanDisponiblePublico }
  | { readonly exito: false; readonly motivo: "NO_DISPONIBLE"; readonly plan: PlanNoDisponible }
  | { readonly exito: false; readonly motivo: "CONFLICTO_CONCURRENCIA"; readonly detalle: string };

/** Convierte una FechaISO ("YYYY-MM-DD") a Date UTC de medianoche, evitando
 * que un desfase de huso horario mueva el dia. */
export function fechaISOaDate(fecha: FechaISO): Date {
  return new Date(`${fecha}T00:00:00.000Z`);
}

interface VentanaHoraria {
  readonly horaApertura: HoraISO;
  readonly horaCierre: HoraISO;
  readonly almuerzoInicio: HoraISO | null;
  readonly almuerzoFin: HoraISO | null;
}

async function resolverVentanasDelDia(
  cliente: ClientePrisma,
  servicioId: IdServicio,
  fecha: FechaISO,
): Promise<readonly VentanaHoraria[]> {
  const fechaDate = fechaISOaDate(fecha);

  const excepciones = await cliente.scheduleException.findMany({
    where: { servicioId, fecha: fechaDate },
  });

  // Una excepcion CERRADO cierra la fecha por completo (6.2: "los feriados no
  // se asumiran abiertos automaticamente").
  if (excepciones.some((e) => e.tipo === "CERRADO")) {
    return [];
  }

  const ventanasExcepcion = excepciones.filter(
    (e) => e.tipo === "HABILITADO" || e.tipo === "MODIFICADO",
  );
  if (ventanasExcepcion.length > 0) {
    return ventanasExcepcion.map((e) => ({
      horaApertura: e.horaApertura as HoraISO,
      horaCierre: e.horaCierre as HoraISO,
      almuerzoInicio: (e.almuerzoInicio as HoraISO | null) ?? null,
      almuerzoFin: (e.almuerzoFin as HoraISO | null) ?? null,
    }));
  }

  const diaSemana = fechaDate.getUTCDay();
  const plantilla = await cliente.scheduleTemplate.findUnique({
    where: { servicioId_diaSemana: { servicioId, diaSemana } },
  });
  if (!plantilla || !plantilla.activo) {
    return [];
  }

  return [
    {
      horaApertura: plantilla.horaApertura as HoraISO,
      horaCierre: plantilla.horaCierre as HoraISO,
      almuerzoInicio: (plantilla.almuerzoInicio as HoraISO | null) ?? null,
      almuerzoFin: (plantilla.almuerzoFin as HoraISO | null) ?? null,
    },
  ];
}

/**
 * Reconstruye el `ContextoDisponibilidad` completo del dia desde la base de
 * datos. Es de solo lectura: no crea ni bloquea nada. Se usa tanto en la
 * consulta (fuera de transaccion) como dentro de la transaccion de
 * confirmacion (para revalidar con datos frescos y, en ese segundo caso,
 * bajo los locks tomados por `bloquearFilasInvolucradas`).
 */
async function construirContextoDisponibilidad(
  cliente: ClientePrisma,
  servicioId: IdServicio,
  fecha: FechaISO,
  /** 14.6: al recalcular el plan de una reserva que se esta reprogramando,
   * sus propias asignaciones ACTIVA no deben contar como ocupacion — de lo
   * contrario reprogramar hacia el mismo horario (o uno solapado) se
   * autobloquearia contando dos veces la misma gente. */
  reservationIdAIgnorar?: string,
): Promise<ContextoDisponibilidad> {
  const fechaDate = fechaISOaDate(fecha);
  const ahora = new Date();

  const [ventanas, heats, bloqueos, servicio] = await Promise.all([
    resolverVentanasDelDia(cliente, servicioId, fecha),
    cliente.heat.findMany({
      where: { servicioId, fecha: fechaDate },
      orderBy: { horaInicio: "asc" },
      include: {
        lote: true,
        asignaciones: {
          where: { estado: "ACTIVA" },
          include: { reservation: { select: { estado: true, expiraEn: true } } },
        },
      },
    }),
    cliente.administrativeBlock.findMany({ where: { servicioId, fecha: fechaDate } }),
    cliente.service.findUnique({ where: { id: servicioId } }),
  ]);

  const bloques: BloqueDeCalendario[] = [];

  for (let minuto = 0; minuto < 24 * 60; minuto += 15) {
    const horaInicio = minutosAHora(minuto);
    const horaFin = minutosAHora(minuto + 15);

    // 1) Heat existente (maxima prioridad: es estado operativo ya comprometido).
    const heat = heats.find((h) => h.horaInicio === horaInicio);
    if (heat) {
      let personasConfirmadas = 0;
      let personasRetenidas = 0;
      for (const asignacion of heat.asignaciones) {
        if (asignacion.reservationId === reservationIdAIgnorar) continue;
        const r = asignacion.reservation;
        if (r.estado === "CONFIRMADA") {
          personasConfirmadas += asignacion.cantidadParticipantes;
        } else if (
          r.estado === "PENDIENTE_VALIDACION_SINPE" ||
          (r.estado === "TEMPORAL" && r.expiraEn !== null && r.expiraEn > ahora)
        ) {
          // 6.5: retenidos = reservas temporales vigentes + SINPE pendiente de validar.
          personasRetenidas += asignacion.cantidadParticipantes;
        }
      }
      bloques.push({
        tipo: "heat",
        fecha,
        horaInicio,
        horaFin,
        heatId: heat.id,
        loteId: heat.loteId,
        posicionEnLote: heat.posicionEnLote,
        personasConfirmadas,
        personasRetenidas,
        capacidadOcupada: personasConfirmadas + personasRetenidas,
      });
      continue;
    }

    // 2) Limpieza de un lote existente.
    const lote = heats
      .map((h) => h.lote)
      .find(
        (l) => horaAMinutos(l.horaInicioLimpieza) <= minuto && minuto < horaAMinutos(l.horaFinLimpieza),
      );
    if (lote) {
      bloques.push({ tipo: "limpieza", fecha, horaInicio, horaFin, loteId: lote.id });
      continue;
    }

    // 3) Bloqueo administrativo (evento privado, mantenimiento; 6.6).
    const bloqueo = bloqueos.find(
      (b) => horaAMinutos(b.horaInicio) <= minuto && minuto < horaAMinutos(b.horaFin),
    );
    if (bloqueo) {
      bloques.push({
        tipo: "bloqueado",
        fecha,
        horaInicio,
        horaFin,
        idBloqueoAdministrativo: bloqueo.id,
        motivo: bloqueo.motivo ?? undefined,
      });
      continue;
    }

    // 4) Fuera de cualquier ventana abierta => cerrado (6.4).
    const dentroDeVentana = ventanas.some(
      (v) => horaAMinutos(v.horaApertura) <= minuto && minuto + 15 <= horaAMinutos(v.horaCierre),
    );
    if (!dentroDeVentana) {
      bloques.push({ tipo: "cerrado", fecha, horaInicio, horaFin });
      continue;
    }

    // 5) Almuerzo (6.2, 6.3).
    const dentroDeAlmuerzo = ventanas.some(
      (v) =>
        v.almuerzoInicio !== null &&
        v.almuerzoFin !== null &&
        horaAMinutos(v.almuerzoInicio) <= minuto &&
        minuto + 15 <= horaAMinutos(v.almuerzoFin),
    );
    if (dentroDeAlmuerzo) {
      bloques.push({ tipo: "almuerzo", fecha, horaInicio, horaFin });
      continue;
    }

    // 6) Nada mas lo ocupa: disponible.
    bloques.push({ tipo: "disponible", fecha, horaInicio, horaFin });
  }

  return {
    rejilla: bloques,
    tarifa: servicio
      ? {
          servicioId,
          moneda: servicio.moneda,
          precioPorPersona: Number(servicio.precioPorPersona),
          porcentajeDeposito: servicio.porcentajeDeposito,
        }
      : undefined,
  };
}

async function construirPlanDesde(
  cliente: ClientePrisma,
  solicitud: SolicitudConsultarDisponibilidad,
  reservationIdAIgnorar?: string,
): Promise<PlanDisponibilidad> {
  const contexto = await construirContextoDisponibilidad(
    cliente,
    solicitud.servicioId,
    solicitud.fecha,
    reservationIdAIgnorar,
  );
  return construirPlan({
    fecha: solicitud.fecha,
    horaInicioCandidata: solicitud.horaInicioCandidata,
    cantidadPersonas: solicitud.cantidadPersonas,
    servicioId: solicitud.servicioId,
    contexto,
  });
}

/**
 * Construye una propuesta de plan sin persistir ni bloquear nada. No abre una
 * transaccion de escritura: es puramente informativa (8.6). El plan devuelto
 * puede quedar obsoleto si otro cliente reserva antes; por eso `confirmarReserva`
 * siempre recalcula desde cero dentro de su propia transaccion (8.8). Nunca
 * incluye informacion de limpieza (ver `aResultadoPublico`).
 */
export async function consultarDisponibilidad(
  prisma: PrismaClient,
  solicitud: SolicitudConsultarDisponibilidad,
): Promise<PlanDisponibilidadPublico> {
  return aResultadoPublico(await construirPlanDesde(prisma, solicitud));
}

export interface CandidatoDelDia {
  readonly horaInicioCandidata: HoraISO;
  readonly plan: PlanDisponibilidadPublico;
}

/**
 * Version "dropdown" de `consultarDisponibilidad` (8.7): evalua TODOS los
 * intervalos de 15 minutos del dia para un mismo (servicioId, fecha,
 * cantidadPersonas). A diferencia de llamar a `consultarDisponibilidad` una
 * vez por candidato (lo que dispararia las 3 queries de
 * `construirContextoDisponibilidad` y reconstruiria la rejilla de 96 bloques
 * en cada uno de los ~96 candidatos), aqui el `ContextoDisponibilidad` se
 * construye UNA SOLA VEZ y se reutiliza para cada llamada a `construirPlan`
 * (que ya es pura y ya acepta un contexto prearmado). Sigue siendo
 * puramente informativa: no persiste ni bloquea nada, igual que
 * `consultarDisponibilidad`.
 */
export async function consultarDisponibilidadDelDia(
  prisma: PrismaClient,
  servicioId: IdServicio,
  fecha: FechaISO,
  cantidadPersonas: number,
): Promise<readonly CandidatoDelDia[]> {
  const contexto = await construirContextoDisponibilidad(prisma, servicioId, fecha);

  const candidatos: CandidatoDelDia[] = [];
  for (let minuto = 0; minuto < 24 * 60; minuto += 15) {
    const horaInicioCandidata = minutosAHora(minuto);
    const plan = construirPlan({
      fecha,
      horaInicioCandidata,
      cantidadPersonas,
      servicioId,
      contexto,
    });
    candidatos.push({ horaInicioCandidata, plan: aResultadoPublico(plan) });
  }
  return candidatos;
}

/** Solo las horas de inicio que producen un plan completo (8.7): la lista
 * que alimenta el dropdown publico de horas. */
export async function listarHorasDisponibles(
  prisma: PrismaClient,
  servicioId: IdServicio,
  fecha: FechaISO,
  cantidadPersonas: number,
): Promise<readonly HoraISO[]> {
  const candidatos = await consultarDisponibilidadDelDia(prisma, servicioId, fecha, cantidadPersonas);
  return candidatos.filter((c) => c.plan.disponible).map((c) => c.horaInicioCandidata);
}

export interface ServicioPublico {
  readonly id: IdServicio;
  readonly nombre: string;
  readonly slug: string;
  readonly moneda: string;
  readonly precioPorPersona: number;
  readonly porcentajeDeposito: number;
}

/** Catalogo de servicios activos (18.1: `GET /api/services`). En el MVP
 * siempre devuelve solo karts, pero no asume eso: lee lo que haya marcado
 * `activo` en la base de datos (27: preparacion para futuros recursos RC). */
export async function listarServiciosActivos(prisma: PrismaClient): Promise<readonly ServicioPublico[]> {
  const servicios = await prisma.service.findMany({ where: { activo: true } });
  return servicios.map((s) => ({
    id: s.id,
    nombre: s.nombre,
    slug: s.slug,
    moneda: s.moneda,
    precioPorPersona: Number(s.precioPorPersona),
    porcentajeDeposito: s.porcentajeDeposito,
  }));
}

/** "YYYY-MM" -> ultimo dia de ese mes (28-31). */
function ultimoDiaDelMes(anioMes: string): number {
  const [anio, mes] = anioMes.split("-").map(Number);
  // Dia 0 del mes siguiente = ultimo dia de `mes` (Date normaliza el desborde).
  return new Date(Date.UTC(anio!, mes!, 0)).getUTCDate();
}

/**
 * Fechas del mes que tienen al menos un plan completo para `cantidadPersonas`
 * (10.3: "una fecha debera considerarse disponible solamente si existe al
 * menos un plan completo para la cantidad solicitada"). Recorre los dias del
 * mes SECUENCIALMENTE (no en paralelo) para no disparar 28-31 consultas
 * simultaneas contra la base de datos; es una vista de calendario, no un
 * candidato de reserva en el camino critico.
 */
export async function listarFechasConDisponibilidad(
  prisma: PrismaClient,
  servicioId: IdServicio,
  anioMes: string,
  cantidadPersonas: number,
): Promise<readonly FechaISO[]> {
  const fechasDisponibles: FechaISO[] = [];
  const ultimoDia = ultimoDiaDelMes(anioMes);

  for (let dia = 1; dia <= ultimoDia; dia++) {
    const fecha = `${anioMes}-${String(dia).padStart(2, "0")}`;
    const candidatos = await consultarDisponibilidadDelDia(prisma, servicioId, fecha, cantidadPersonas);
    if (candidatos.some((c) => c.plan.disponible)) {
      fechasDisponibles.push(fecha);
    }
  }
  return fechasDisponibles;
}

/** Inverso de `fechaISOaDate`: recupera "YYYY-MM-DD" de una medianoche UTC. */
function dateAFechaISO(fecha: Date): FechaISO {
  return fecha.toISOString().slice(0, 10);
}

export interface HeatDeReservaPublico {
  readonly horaInicio: HoraISO;
  readonly horaFin: HoraISO;
  readonly personas: number;
}

export interface LoteDeReservaPublico {
  readonly heats: readonly HeatDeReservaPublico[];
}

export interface ReservaPublica {
  readonly codigoPublico: string;
  readonly estado: string;
  readonly fecha: FechaISO;
  readonly cantidadPersonas: number;
  readonly moneda: string;
  readonly montoTotal: number;
  readonly montoDeposito: number;
  readonly montoSaldo: number;
  /** Ordenados cronologicamente; nunca incluyen la limpieza (8.7, 10.7). */
  readonly lotes: readonly LoteDeReservaPublico[];
}

/**
 * Estado publico de una reserva por su codigo (18.1:
 * `GET /api/reservations/{publicCode}`, 10.7). `null` si no existe ningun
 * codigo asi. Reconstruye los lotes/heats desde las asignaciones ACTIVA
 * persistidas (no vuelve a calcular un plan): una reserva ya confirmada o
 * vencida no debe cambiar de forma solo porque alguien la consulta.
 */
export async function consultarReservaPorCodigo(
  prisma: PrismaClient,
  codigoPublico: string,
): Promise<ReservaPublica | null> {
  const reserva = await prisma.reservation.findUnique({ where: { codigoPublico } });
  if (!reserva) return null;

  const asignaciones = await prisma.heatAllocation.findMany({
    where: { reservationId: reserva.id, estado: "ACTIVA" },
  });

  const heatsPorLote = new Map<string, HeatDeReservaPublico[]>();
  for (const asignacion of asignaciones) {
    const heat = await prisma.heat.findUnique({ where: { id: asignacion.heatId } });
    if (!heat) continue;
    const heatsDelLote = heatsPorLote.get(heat.loteId) ?? [];
    heatsDelLote.push({
      horaInicio: heat.horaInicio as HoraISO,
      horaFin: heat.horaFin as HoraISO,
      personas: asignacion.cantidadParticipantes,
    });
    heatsPorLote.set(heat.loteId, heatsDelLote);
  }

  const lotes: LoteDeReservaPublico[] = [...heatsPorLote.values()]
    .map((heats) => ({ heats: [...heats].sort((a, b) => a.horaInicio.localeCompare(b.horaInicio)) }))
    .sort((a, b) => a.heats[0]!.horaInicio.localeCompare(b.heats[0]!.horaInicio));

  return {
    codigoPublico: reserva.codigoPublico,
    estado: reserva.estado,
    fecha: dateAFechaISO(reserva.fecha),
    cantidadPersonas: reserva.cantidadPersonas,
    moneda: reserva.moneda,
    montoTotal: Number(reserva.montoTotal),
    montoDeposito: Number(reserva.montoDeposito),
    montoSaldo: Number(reserva.montoSaldo),
    lotes,
  };
}

/** Toma locks pesimistas sobre los Heat/OperationalBatch EXISTENTES indicados.
 * Los ids se ordenan antes de bloquear para reducir la ventana de deadlock
 * entre transacciones concurrentes que bloqueen conjuntos solapados (no es
 * una garantia absoluta sin `ORDER BY id` en el propio SQL, pero Postgres
 * puede seguir abortando y reintentando una transaccion ante un deadlock
 * real; la logica de reintento de `confirmarReserva` ya cubre ese caso). */
async function bloquearFilasInvolucradas(
  tx: Prisma.TransactionClient,
  heatIds: readonly string[],
  loteIds: readonly string[],
): Promise<void> {
  const heatIdsOrdenados = [...heatIds].sort();
  const loteIdsOrdenados = [...loteIds].sort();

  if (heatIdsOrdenados.length > 0) {
    await tx.$queryRaw`
      SELECT id FROM "heats" WHERE id = ANY(${heatIdsOrdenados}::text[]) ORDER BY id FOR UPDATE
    `;
  }
  if (loteIdsOrdenados.length > 0) {
    await tx.$queryRaw`
      SELECT id FROM "operational_batches" WHERE id = ANY(${loteIdsOrdenados}::text[]) ORDER BY id FOR UPDATE
    `;
  }
}

/** Extrae los ids de Heat/OperationalBatch ya existentes referenciados por un plan. */
function idsExistentesDelPlan(plan: PlanDisponible): { heatIds: string[]; loteIds: string[] } {
  const heatIds: string[] = [];
  const loteIds: string[] = [];
  for (const lote of plan.lotes) {
    if (lote.loteId !== null) loteIds.push(lote.loteId);
    for (const heat of lote.heats) {
      if (heat.heatId !== null) heatIds.push(heat.heatId);
    }
  }
  return { heatIds, loteIds };
}

/** Se lanza cuando `calcularYBloquearPlanFinal` no logra estabilizar el plan
 * bajo lock tras `MAX_RONDAS_ESTABILIZACION` intentos; `confirmarReserva` la
 * trata igual que un choque de unicidad (retry acotado / conflicto). */
export class ConflictoBloqueoInestable extends Error {
  constructor() {
    super("El plan recalculado no se estabilizo bajo lock tras varias rondas");
    this.name = "ConflictoBloqueoInestable";
  }
}

const MAX_RONDAS_ESTABILIZACION = 3;

export type ResultadoCalculoPlan =
  | { readonly disponible: true; readonly plan: PlanDisponible }
  | { readonly disponible: false; readonly plan: PlanNoDisponible };

/**
 * Calcula el plan final DENTRO de la transaccion, bloqueando en cada ronda
 * las filas existentes que el plan de esa ronda referencia y volviendo a
 * recalcular bajo ese lock, hasta llegar a un punto fijo: un plan que ya no
 * toca ninguna fila que no este bloqueada. Esto cierra la ventana entre "ver"
 * una fila candidata (lectura sin lock) y "bloquearla" que existia al
 * bloquear una sola vez con los ids de un plan calculado antes del lock
 * (8.8.3-4): si el contexto cambia entre rondas (otra transaccion confirmo
 * un heat que ahora resulta mas conveniente), la siguiente ronda lo detecta,
 * lo bloquea tambien y vuelve a validar.
 */
export async function calcularYBloquearPlanFinal(
  tx: Prisma.TransactionClient,
  solicitud: SolicitudConsultarDisponibilidad,
  reservationIdAIgnorar?: string,
): Promise<ResultadoCalculoPlan> {
  const heatIdsBloqueados = new Set<string>();
  const loteIdsBloqueados = new Set<string>();

  let planCandidato = await construirPlanDesde(tx, solicitud, reservationIdAIgnorar);

  for (let ronda = 0; ronda < MAX_RONDAS_ESTABILIZACION; ronda++) {
    if (!planCandidato.disponible) {
      return { disponible: false, plan: planCandidato };
    }

    const { heatIds, loteIds } = idsExistentesDelPlan(planCandidato);
    const heatIdsNuevos = heatIds.filter((id) => !heatIdsBloqueados.has(id));
    const loteIdsNuevos = loteIds.filter((id) => !loteIdsBloqueados.has(id));

    if (heatIdsNuevos.length === 0 && loteIdsNuevos.length === 0) {
      // El plan actual no depende de ninguna fila existente sin bloquear:
      // es un punto fijo seguro para persistir (los heats nuevos que cree
      // quedan protegidos por el indice unico, no por este lock).
      return { disponible: true, plan: planCandidato };
    }

    await bloquearFilasInvolucradas(tx, heatIdsNuevos, loteIdsNuevos);
    heatIdsNuevos.forEach((id) => heatIdsBloqueados.add(id));
    loteIdsNuevos.forEach((id) => loteIdsBloqueados.add(id));

    // Recalcular bajo el lock recien tomado: el contexto puede haber
    // cambiado desde la ronda anterior (8.8.4).
    planCandidato = await construirPlanDesde(tx, solicitud, reservationIdAIgnorar);
  }

  throw new ConflictoBloqueoInestable();
}

/** Genera un codigo publico de reserva legible (no es la clave de idempotencia). */
function generarCodigoPublico(): string {
  return `SRP-${Date.now().toString(36).toUpperCase()}-${Math.floor(Math.random() * 36 ** 4)
    .toString(36)
    .padStart(4, "0")
    .toUpperCase()}`;
}

/** Restriccion unica identificada por su nombre estable (declarado via `map`
 * en schema.prisma) y por los campos Prisma (camelCase) que la componen. */
export interface RestriccionUnica {
  readonly nombre: string;
  readonly campos: readonly string[];
}

/** Ver `@@unique(..., map: "heats_service_id_fecha_hora_inicio_key")` en Heat. */
export const RESTRICCION_HEAT_UNICO: RestriccionUnica = {
  nombre: "heats_service_id_fecha_hora_inicio_key",
  campos: ["servicioId", "fecha", "horaInicio"],
};
/** Ver `claveIdempotencia @unique(map: "reservations_clave_idempotencia_key")` en Reservation. */
const RESTRICCION_CLAVE_IDEMPOTENCIA: RestriccionUnica = {
  nombre: "reservations_clave_idempotencia_key",
  campos: ["claveIdempotencia"],
};
/** Ver `codigoPublico @unique(map: "reservations_public_code_key")` en Reservation. */
const RESTRICCION_CODIGO_PUBLICO: RestriccionUnica = {
  nombre: "reservations_public_code_key",
  campos: ["codigoPublico"],
};

/**
 * true si `error` es una violacion de restriccion unica de Prisma (P2002)
 * para exactamente `restriccion`. `error.meta.target` puede llegar como el
 * nombre de la restriccion (string) o como el array de campos que la
 * componen, segun el proveedor/version de Prisma; en ambos casos se compara
 * con igualdad EXACTA contra el nombre declarado explicitamente via `map` en
 * schema.prisma (o contra el conjunto exacto de campos), nunca con
 * coincidencia parcial/heuristica sobre alias adivinados.
 */
export function esViolacionUnica(error: unknown, restriccion: RestriccionUnica): boolean {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== "P2002") {
    return false;
  }
  const target = error.meta?.target;
  if (typeof target === "string") {
    return target === restriccion.nombre;
  }
  if (Array.isArray(target)) {
    return (
      target.length === restriccion.campos.length &&
      restriccion.campos.every((campo) => (target as unknown[]).includes(campo))
    );
  }
  return false;
}

/**
 * Persiste un `PlanDisponible` ya validado y bloqueado (ver
 * `calcularYBloquearPlanFinal`) para una reserva EXISTENTE: crea/reutiliza
 * los OperationalBatch/Heat del plan y crea las HeatAllocation ACTIVA que le
 * dan a `reservationId` su capacidad en cada heat. Reutilizada tanto por
 * `confirmarReserva` (reserva recien creada) como por `reprogramarReserva`
 * en gestion-reservas.service.ts (reserva existente que cambia de plan,
 * 14.6): la logica de "como se materializa un plan en filas" es identica en
 * ambos casos, solo cambia el origen del `reservationId`.
 */
export async function persistirPlanParaReserva(
  tx: Prisma.TransactionClient,
  servicioId: IdServicio,
  fecha: FechaISO,
  reservationId: string,
  planFinal: PlanDisponible,
): Promise<void> {
  for (const lote of planFinal.lotes) {
    let loteId = lote.loteId;
    if (loteId === null) {
      const nuevoLote = await tx.operationalBatch.create({
        data: {
          servicioId,
          fecha: fechaISOaDate(fecha),
          horaInicio: lote.horaInicio,
          horaFinUltimoHeat: lote.horaFinActividadCliente,
          horaInicioLimpieza: lote.horaFinActividadCliente,
          horaFinLimpieza: lote.horaFinLimpieza,
          cantidadHeats: lote.heats.length,
        },
      });
      loteId = nuevoLote.id;
    } else if (lote.esLoteReutilizado) {
      // Ampliacion de un lote existente: se desplaza su limpieza (8.3, DISP-015).
      await tx.operationalBatch.update({
        where: { id: loteId },
        data: {
          horaFinUltimoHeat: lote.horaFinActividadCliente,
          horaInicioLimpieza: lote.horaFinActividadCliente,
          horaFinLimpieza: lote.horaFinLimpieza,
          cantidadHeats: lote.heats.length,
        },
      });
    }

    for (let i = 0; i < lote.heats.length; i++) {
      const heatPropuesto = lote.heats[i]!;
      let heatId = heatPropuesto.heatId;
      if (heatId === null) {
        const nuevoHeat = await tx.heat.create({
          data: {
            loteId,
            servicioId,
            fecha: fechaISOaDate(fecha),
            horaInicio: heatPropuesto.horaInicio,
            horaFin: heatPropuesto.horaFin,
            posicionEnLote: i + 1,
          },
        });
        heatId = nuevoHeat.id;
      } else {
        // Heat reutilizado: `i` es su posicion FINAL dentro de este lote (ya
        // reordenado por el motor), que puede diferir de la que tenia antes
        // de esta reserva si un heat nuevo quedo colocado cronologicamente
        // antes de el (6.1.12, ejemplo 9.9). Sin este update, dos heats del
        // mismo lote podrian terminar compartiendo el mismo posicionEnLote.
        await tx.heat.update({
          where: { id: heatId },
          data: { posicionEnLote: i + 1 },
        });
      }

      await tx.heatAllocation.create({
        data: {
          reservationId,
          heatId,
          cantidadParticipantes: heatPropuesto.personasAsignadas,
        },
      });
    }
  }
}

const PLAN_VACIO_IDEMPOTENTE: PlanDisponiblePublico = {
  disponible: true,
  cantidadLotes: 0,
  distribucion: [],
  lotes: [],
  horaFinActividadCliente: "00:00",
  capacidadesRetenidas: [],
};

/**
 * Confirma (crea) una reserva. Revalida el plan dentro de una transaccion que
 * bloquea las filas existentes involucradas hasta estabilizar un punto fijo
 * (8.8, ver `calcularYBloquearPlanFinal`) y, si el plan sigue siendo valido,
 * crea/actualiza OperationalBatch/Heat/HeatAllocation/Reservation de forma
 * atomica. Reintenta un numero acotado de veces si la revalidacion detecta
 * que otro cliente tomo la capacidad justo antes del lock, si el bloqueo no
 * logro estabilizarse, o si colisiona el codigo publico generado (8.8.6);
 * agotados los reintentos, devuelve un conflicto explicito para que el
 * cliente vuelva a consultar disponibilidad.
 */
export async function confirmarReserva(
  prisma: PrismaClient,
  solicitud: SolicitudConfirmarReserva,
  intentosMaximos = 3,
): Promise<ResultadoConfirmacion> {
  // Camino rapido de idempotencia (8.8.7): si ya existe una reserva con esta
  // clave, se devuelve tal cual sin recalcular nada. La restriccion unica en
  // `claveIdempotencia` es la garantia real ante una carrera; este chequeo
  // solo evita trabajo innecesario en el caso comun.
  const existente = await prisma.reservation.findUnique({
    where: { claveIdempotencia: solicitud.claveIdempotencia },
  });
  if (existente) {
    return {
      exito: true,
      idReserva: existente.id,
      codigoPublico: existente.codigoPublico,
      plan: PLAN_VACIO_IDEMPOTENTE,
    };
  }

  for (let intento = 1; intento <= intentosMaximos; intento++) {
    try {
      return await prisma.$transaction(
        async (tx) => {
          const resultado = await calcularYBloquearPlanFinal(tx, solicitud);
          if (!resultado.disponible) {
            return { exito: false, motivo: "NO_DISPONIBLE", plan: resultado.plan };
          }
          const planFinal = resultado.plan;

          // Persistencia atomica del plan final (8.8.5).
          const reservation = await tx.reservation.create({
            data: {
              codigoPublico: generarCodigoPublico(),
              servicioId: solicitud.servicioId,
              fecha: fechaISOaDate(solicitud.fecha),
              cantidadPersonas: solicitud.cantidadPersonas,
              estado: "TEMPORAL",
              moneda: planFinal.precio?.moneda ?? "CRC",
              montoTotal: planFinal.precio?.montoTotal ?? 0,
              montoDeposito: planFinal.precio?.montoDeposito ?? 0,
              montoSaldo: planFinal.precio?.montoSaldo ?? 0,
              claveIdempotencia: solicitud.claveIdempotencia,
              clienteNombre: solicitud.cliente.nombre,
              clienteTelefono: solicitud.cliente.telefono,
              clienteEmail: solicitud.cliente.email,
              expiraEn: new Date(Date.now() + 30 * 60 * 1000), // 6.7.1
            },
          });

          await persistirPlanParaReserva(tx, solicitud.servicioId, solicitud.fecha, reservation.id, planFinal);

          return {
            exito: true,
            idReserva: reservation.id,
            codigoPublico: reservation.codigoPublico,
            plan: ocultarLimpieza(planFinal),
          };
        },
        { maxWait: 5_000, timeout: 10_000 },
      );
    } catch (error) {
      // Doble clic / reintento de red bajo carrera: otra copia de la misma
      // solicitud ya creo la reserva con esta clave de idempotencia.
      if (esViolacionUnica(error, RESTRICCION_CLAVE_IDEMPOTENCIA)) {
        const creadaPorOtroIntento = await prisma.reservation.findUniqueOrThrow({
          where: { claveIdempotencia: solicitud.claveIdempotencia },
        });
        return {
          exito: true,
          idReserva: creadaPorOtroIntento.id,
          codigoPublico: creadaPorOtroIntento.codigoPublico,
          plan: PLAN_VACIO_IDEMPOTENTE,
        };
      }
      // Tres causas distintas que ameritan el mismo tratamiento (reintentar
      // con contexto fresco; si se agotan los intentos, informar el
      // conflicto): (a) choque de dos transacciones creando el mismo heat
      // nuevo en la misma ranura — unique de servicioId+fecha+horaInicio,
      // otro cliente gano la capacidad justo antes del lock (8.8.6); (b)
      // colision del codigo publico generado; (c) el bloqueo no logro
      // estabilizarse en un punto fijo tras varias rondas.
      const esConflictoDeCapacidad =
        esViolacionUnica(error, RESTRICCION_HEAT_UNICO) ||
        esViolacionUnica(error, RESTRICCION_CODIGO_PUBLICO);
      if (esConflictoDeCapacidad || error instanceof ConflictoBloqueoInestable) {
        if (intento < intentosMaximos) continue;
        return {
          exito: false,
          motivo: "CONFLICTO_CONCURRENCIA",
          detalle: "La disponibilidad cambio mientras se procesaba la reserva.",
        };
      }
      throw error;
    }
  }

  return {
    exito: false,
    motivo: "CONFLICTO_CONCURRENCIA",
    detalle: "No se pudo confirmar la reserva tras varios intentos por alta concurrencia.",
  };
}
