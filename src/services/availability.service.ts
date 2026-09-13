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
function ocultarLimpieza(plan: PlanDisponible): PlanDisponiblePublico {
  const { liberacionOperativa: _liberacionOperativa, lotes, ...resto } = plan;
  return { ...resto, lotes: lotes.map(ocultarLimpiezaDelLote) };
}

/** Version de `ocultarLimpieza` para el resultado completo de `construirPlan`
 * (disponible o no); un `PlanNoDisponible` no tiene nada que ocultar. */
function aResultadoPublico(plan: PlanDisponibilidad): PlanDisponibilidadPublico {
  return plan.disponible ? ocultarLimpieza(plan) : plan;
}

export type ResultadoConfirmacion =
  | { readonly ok: true; readonly reservationId: string; readonly publicCode: string; readonly plan: PlanDisponiblePublico }
  | { readonly ok: false; readonly motivo: "NO_DISPONIBLE"; readonly plan: PlanNoDisponible }
  | { readonly ok: false; readonly motivo: "CONFLICTO_CONCURRENCIA"; readonly detalle: string };

/** Convierte una FechaISO ("YYYY-MM-DD") a Date UTC de medianoche, evitando
 * que un desfase de huso horario mueva el dia. */
function fechaISOaDate(fecha: FechaISO): Date {
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
        const r = asignacion.reservation;
        if (r.estado === "CONFIRMADA") {
          personasConfirmadas += asignacion.participantCount;
        } else if (
          r.estado === "PENDIENTE_VALIDACION_SINPE" ||
          (r.estado === "TEMPORAL" && r.expiraEn !== null && r.expiraEn > ahora)
        ) {
          // 6.5: retenidos = reservas temporales vigentes + SINPE pendiente de validar.
          personasRetenidas += asignacion.participantCount;
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
): Promise<PlanDisponibilidad> {
  const contexto = await construirContextoDisponibilidad(cliente, solicitud.servicioId, solicitud.fecha);
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
class ConflictoBloqueoInestable extends Error {
  constructor() {
    super("El plan recalculado no se estabilizo bajo lock tras varias rondas");
    this.name = "ConflictoBloqueoInestable";
  }
}

const MAX_RONDAS_ESTABILIZACION = 3;

type ResultadoCalculoPlan =
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
async function calcularYBloquearPlanFinal(
  tx: Prisma.TransactionClient,
  solicitud: SolicitudConfirmarReserva,
): Promise<ResultadoCalculoPlan> {
  const heatIdsBloqueados = new Set<string>();
  const loteIdsBloqueados = new Set<string>();

  let planCandidato = await construirPlanDesde(tx, solicitud);

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
    planCandidato = await construirPlanDesde(tx, solicitud);
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

function normalizarToken(valor: string): string {
  return valor.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/**
 * true si `error` es una violacion de restriccion unica de Prisma (P2002)
 * cuyo `target` menciona alguno de los `alias` dados. Se aceptan varios
 * alias por campo (ej. el nombre de campo en camelCase junto con el nombre
 * fisico de columna en snake_case) porque `meta.target` puede llegar como
 * array de campos, como el nombre de la restriccion, o como string segun el
 * proveedor/version de Prisma; comparar contra un solo alias fijo (como
 * hacia la version anterior) puede no coincidir con lo que realmente se
 * reporta y dejar pasar el error como no manejado.
 */
function esViolacionUnica(error: unknown, ...alias: string[]): boolean {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== "P2002") {
    return false;
  }
  const target = error.meta?.target;
  const partes: string[] =
    typeof target === "string" ? [target] : Array.isArray(target) ? (target as string[]) : [];
  if (partes.length === 0) return false;
  const textoNormalizado = normalizarToken(partes.join("_"));
  return alias.some((a) => textoNormalizado.includes(normalizarToken(a)));
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
      ok: true,
      reservationId: existente.id,
      publicCode: existente.publicCode,
      plan: PLAN_VACIO_IDEMPOTENTE,
    };
  }

  for (let intento = 1; intento <= intentosMaximos; intento++) {
    try {
      return await prisma.$transaction(
        async (tx) => {
          const resultado = await calcularYBloquearPlanFinal(tx, solicitud);
          if (!resultado.disponible) {
            return { ok: false, motivo: "NO_DISPONIBLE", plan: resultado.plan };
          }
          const planFinal = resultado.plan;

          // Persistencia atomica del plan final (8.8.5).
          const reservation = await tx.reservation.create({
            data: {
              publicCode: generarCodigoPublico(),
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

          for (const lote of planFinal.lotes) {
            let loteId = lote.loteId;
            if (loteId === null) {
              const nuevoLote = await tx.operationalBatch.create({
                data: {
                  servicioId: solicitud.servicioId,
                  fecha: fechaISOaDate(solicitud.fecha),
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
                    servicioId: solicitud.servicioId,
                    fecha: fechaISOaDate(solicitud.fecha),
                    horaInicio: heatPropuesto.horaInicio,
                    horaFin: heatPropuesto.horaFin,
                    posicionEnLote: i + 1,
                  },
                });
                heatId = nuevoHeat.id;
              } else {
                // Heat reutilizado: `i` es su posicion FINAL dentro de este
                // lote (ya reordenado por el motor), que puede diferir de la
                // que tenia antes de esta reserva si un heat nuevo quedo
                // colocado cronologicamente antes de el (6.1.12, ejemplo 9.9).
                // Sin este update, dos heats del mismo lote podrian terminar
                // compartiendo el mismo posicionEnLote.
                await tx.heat.update({
                  where: { id: heatId },
                  data: { posicionEnLote: i + 1 },
                });
              }

              await tx.heatAllocation.create({
                data: {
                  reservationId: reservation.id,
                  heatId,
                  participantCount: heatPropuesto.personasAsignadas,
                },
              });
            }
          }

          return {
            ok: true,
            reservationId: reservation.id,
            publicCode: reservation.publicCode,
            plan: ocultarLimpieza(planFinal),
          };
        },
        { maxWait: 5_000, timeout: 10_000 },
      );
    } catch (error) {
      // Doble clic / reintento de red bajo carrera: otra copia de la misma
      // solicitud ya creo la reserva con esta clave de idempotencia.
      if (esViolacionUnica(error, "claveIdempotencia", "clave_idempotencia")) {
        const creadaPorOtroIntento = await prisma.reservation.findUniqueOrThrow({
          where: { claveIdempotencia: solicitud.claveIdempotencia },
        });
        return {
          ok: true,
          reservationId: creadaPorOtroIntento.id,
          publicCode: creadaPorOtroIntento.publicCode,
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
        esViolacionUnica(error, "servicioId", "service_id") ||
        esViolacionUnica(error, "publicCode", "public_code");
      if (esConflictoDeCapacidad || error instanceof ConflictoBloqueoInestable) {
        if (intento < intentosMaximos) continue;
        return {
          ok: false,
          motivo: "CONFLICTO_CONCURRENCIA",
          detalle: "La disponibilidad cambio mientras se procesaba la reserva.",
        };
      }
      throw error;
    }
  }

  return {
    ok: false,
    motivo: "CONFLICTO_CONCURRENCIA",
    detalle: "No se pudo confirmar la reserva tras varios intentos por alta concurrencia.",
  };
}
