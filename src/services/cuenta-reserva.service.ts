// ============================================================================
// Cuenta de una reserva: lo que realmente se consumio en el parque y lo que se
// cobro, con montos exactos. Una reserva reserva "N personas x heat de 15 min",
// pero en el parque el grupo puede correr el heat de 10 min, repetir un heat
// con todo el grupo o con un subgrupo, o llevar ninos en el kart del adulto.
//
// La cuenta se abre (de forma idempotente) la primera vez que se consulta o
// modifica: se crea una linea base por heat reservado. Desde ese momento la
// suma de las lineas (ConsumoReserva) es el total de la reserva, y el saldo es
// ese total menos lo pagado (Payment en estado PAGADO). Los montos de la
// reserva (montoTotal/montoSaldo) y su estado (CONFIRMADA <-> PAGADA) se
// mantienen sincronizados para que reportes y flujos existentes sigan
// funcionando.
//
// No toca HeatAllocation: los heats extra y los cambios de duracion ocurren en
// el momento, en el parque, y solo se registran y cobran (no reservan cupo).
// ============================================================================

import { Prisma, PrismaClient } from "@prisma/client";
import { UMBRAL_GRUPO_GRANDE } from "../motor-disponibilidad/motor-disponibilidad.js";

type Cliente = PrismaClient | Prisma.TransactionClient;

/** Solo reservas con el deposito pagado tienen cuenta (CONFIRMADA o PAGADA). */
const ESTADOS_CON_CUENTA = new Set(["CONFIRMADA", "PAGADA"]);

export const DURACIONES_HEAT = [10, 15] as const;
export type DuracionHeat = (typeof DURACIONES_HEAT)[number];

/** Metodos que el personal puede registrar al cobrar en caja. SINPE_MANUAL es
 * el SINPE Movil verificado por el personal. */
export const METODOS_COBRO_CAJA = ["EFECTIVO", "SINPE_MANUAL", "TRANSFERENCIA_BANCARIA"] as const;
export type MetodoCobroCaja = (typeof METODOS_COBRO_CAJA)[number];

const LARGO_MAXIMO_TEXTO = 200;

export type TipoLinea = "HEAT" | "NINO_ACOMPANADO" | "AJUSTE";

export interface LineaCuenta {
  readonly id: string;
  readonly tipo: TipoLinea;
  readonly descripcion: string;
  readonly duracionMin: number | null;
  readonly cantidad: number;
  readonly precioUnitario: number;
  readonly monto: number;
  readonly esBase: boolean;
  readonly creadoPor: string | null;
  readonly creadoEn: Date;
}

export interface PagoCuenta {
  readonly id: string;
  readonly tipo: "DEPOSITO" | "SALDO";
  readonly monto: number;
  readonly metodo: string;
  readonly pagadoEn: Date | null;
  readonly nota: string | null;
  readonly registradoPor: string | null;
}

export interface TarifasCuenta {
  readonly heat15GrupoPequeno: number;
  readonly heat15GrupoGrande: number;
  readonly heat10GrupoPequeno: number;
  readonly heat10GrupoGrande: number;
  readonly ninoAcompanado: number;
  readonly umbralGrupoGrande: number;
}

export interface Cuenta {
  readonly codigoPublico: string;
  readonly estado: string;
  readonly moneda: string;
  readonly cantidadPersonas: number;
  readonly lineas: readonly LineaCuenta[];
  /** Solo pagos en estado PAGADO (incluye el deposito). */
  readonly pagos: readonly PagoCuenta[];
  readonly totalConsumido: number;
  readonly totalPagado: number;
  /** total consumido - total pagado. Negativo = el cliente pago de mas. */
  readonly saldo: number;
  readonly tarifas: TarifasCuenta;
}

export type MotivoRechazoCuenta =
  | "NO_ENCONTRADA"
  | "ESTADO_INVALIDO"
  | "DATOS_INVALIDOS"
  | "LINEA_NO_ENCONTRADA"
  | "ULTIMA_LINEA";

export type ResultadoCuenta =
  | { readonly ok: true; readonly cuenta: Cuenta }
  | { readonly ok: false; readonly motivo: MotivoRechazoCuenta };

export type EntradaLinea =
  | { readonly tipo: "HEAT"; readonly duracionMin: number; readonly personas: number; readonly precioUnitario?: number }
  | { readonly tipo: "NINO_ACOMPANADO"; readonly ninos: number; readonly heats: number; readonly precioUnitario?: number }
  | { readonly tipo: "AJUSTE"; readonly monto: number; readonly nota: string };

export interface CambiosLinea {
  readonly duracionMin?: number;
  readonly cantidad?: number;
  readonly precioUnitario?: number;
  readonly descripcion?: string;
}

export interface EntradaPago {
  readonly monto: number;
  readonly metodo: MetodoCobroCaja;
  readonly nota?: string;
}

// -- Helpers puros ----------------------------------------------------------

function redondear(valor: number): number {
  return Math.round(valor * 100) / 100;
}

function esEnteroPositivo(valor: unknown): valor is number {
  return typeof valor === "number" && Number.isInteger(valor) && valor >= 1;
}

function esPrecioValido(valor: unknown): valor is number {
  return typeof valor === "number" && Number.isFinite(valor) && valor >= 0;
}

function esDuracionValida(valor: unknown): valor is DuracionHeat {
  return DURACIONES_HEAT.includes(valor as DuracionHeat);
}

function textoValido(valor: unknown): valor is string {
  return typeof valor === "string" && valor.trim().length > 0 && valor.trim().length <= LARGO_MAXIMO_TEXTO;
}

function precioHeat(tarifas: TarifasCuenta, duracion: DuracionHeat, personas: number): number {
  const grande = personas >= tarifas.umbralGrupoGrande;
  if (duracion === 10) return grande ? tarifas.heat10GrupoGrande : tarifas.heat10GrupoPequeno;
  return grande ? tarifas.heat15GrupoGrande : tarifas.heat15GrupoPequeno;
}

function descripcionHeat(duracion: number, esBase: boolean): string {
  return esBase ? `Heat de ${duracion} min (reservado)` : `Heat de ${duracion} min`;
}

function descripcionNinos(ninos: number, heats: number): string {
  return `Niños acompañantes: ${ninos} × ${heats} ${heats === 1 ? "heat" : "heats"}`;
}

function aTarifas(servicio: {
  precioPorPersonaGrupoPequeno: unknown;
  precioPorPersonaGrupoGrande: unknown;
  precio10GrupoPequeno: unknown;
  precio10GrupoGrande: unknown;
  precioNinoAcompanado: unknown;
}): TarifasCuenta {
  return {
    heat15GrupoPequeno: Number(servicio.precioPorPersonaGrupoPequeno),
    heat15GrupoGrande: Number(servicio.precioPorPersonaGrupoGrande),
    heat10GrupoPequeno: Number(servicio.precio10GrupoPequeno),
    heat10GrupoGrande: Number(servicio.precio10GrupoGrande),
    ninoAcompanado: Number(servicio.precioNinoAcompanado),
    umbralGrupoGrande: UMBRAL_GRUPO_GRANDE,
  };
}

// -- Acceso a datos ----------------------------------------------------------

async function bloquearYLeerReserva(tx: Prisma.TransactionClient, codigoPublico: string) {
  const previa = await tx.reservation.findUnique({ where: { codigoPublico } });
  if (!previa) return null;
  await tx.$queryRaw`SELECT id FROM "reservations" WHERE id = ${previa.id} FOR UPDATE`;
  return tx.reservation.findUnique({ where: { id: previa.id } });
}

type ReservaFila = NonNullable<Awaited<ReturnType<typeof bloquearYLeerReserva>>>;
type ServicioFila = NonNullable<Awaited<ReturnType<PrismaClient["service"]["findUnique"]>>>;

/** Crea las lineas base (una por heat reservado) si la cuenta aun no existe. */
async function abrirCuentaSiHaceFalta(tx: Prisma.TransactionClient, reserva: ReservaFila) {
  const existentes = await tx.consumoReserva.count({ where: { reservationId: reserva.id } });
  if (existentes > 0) return;

  // Se respeta el monto realmente reservado (no se recalcula con la tarifa).
  const vueltas = Math.max(1, reserva.repeticiones ?? 1);
  const montoTotal = Number(reserva.montoTotal);
  const personas = reserva.cantidadPersonas;
  const unitario = redondear(montoTotal / (personas * vueltas));
  const montoPorVuelta = redondear(unitario * personas);
  let acumulado = 0;
  for (let i = 0; i < vueltas; i++) {
    // La ultima absorbe el redondeo para que la suma sea exactamente el total reservado.
    const monto = i === vueltas - 1 ? redondear(montoTotal - acumulado) : montoPorVuelta;
    acumulado = redondear(acumulado + monto);
    await tx.consumoReserva.create({
      data: {
        reservationId: reserva.id,
        tipo: "HEAT",
        descripcion: descripcionHeat(15, true),
        duracionMin: 15,
        cantidad: personas,
        precioUnitario: unitario,
        monto,
        esBase: true,
        creadoPor: null,
      },
    });
  }
}

async function cargarServicio(cliente: Cliente, servicioId: string): Promise<ServicioFila | null> {
  return cliente.service.findUnique({ where: { id: servicioId } });
}

async function construirCuenta(cliente: Cliente, reservaId: string, servicio: ServicioFila): Promise<Cuenta> {
  const reserva = await cliente.reservation.findUnique({ where: { id: reservaId } });
  if (!reserva) throw new Error(`Reserva ${reservaId} desaparecio dentro de la transaccion`);
  // Orden por fecha de creacion y luego id: las lineas base de una misma
  // transaccion comparten fecha, y el id desempata de forma estable.
  const lineasDb = await cliente.consumoReserva.findMany({
    where: { reservationId: reservaId },
    orderBy: [{ creadoEn: "asc" }, { id: "asc" }],
  });
  const pagosDb = await cliente.payment.findMany({
    where: { reservationId: reservaId },
    orderBy: { creadoEn: "asc" },
  });

  const lineas: LineaCuenta[] = lineasDb.map((l) => ({
    id: l.id,
    tipo: l.tipo,
    descripcion: l.descripcion,
    duracionMin: l.duracionMin ?? null,
    cantidad: l.cantidad,
    precioUnitario: Number(l.precioUnitario),
    monto: Number(l.monto),
    esBase: l.esBase,
    creadoPor: l.creadoPor ?? null,
    creadoEn: l.creadoEn,
  }));
  const pagos: PagoCuenta[] = pagosDb
    .filter((p) => p.estado === "PAGADO")
    .map((p) => ({
      id: p.id,
      tipo: p.tipo,
      monto: Number(p.monto),
      metodo: p.metodo,
      pagadoEn: p.pagadoEn ?? null,
      nota: p.nota ?? null,
      registradoPor: p.registradoPor ?? null,
    }));

  const totalConsumido = redondear(lineas.reduce((suma, l) => suma + l.monto, 0));
  let totalPagado = redondear(pagos.reduce((suma, p) => suma + p.monto, 0));
  // Reservas antiguas pudieron confirmarse sin registrar el deposito en el ledger.
  if (!pagos.some((p) => p.tipo === "DEPOSITO")) totalPagado = redondear(totalPagado + Number(reserva.montoDeposito));

  return {
    codigoPublico: reserva.codigoPublico,
    estado: reserva.estado,
    moneda: reserva.moneda,
    cantidadPersonas: reserva.cantidadPersonas,
    lineas,
    pagos,
    totalConsumido,
    totalPagado,
    saldo: redondear(totalConsumido - totalPagado),
    tarifas: aTarifas(servicio),
  };
}

/** Deja montoTotal, montoSaldo y estado de la reserva en linea con la cuenta. */
async function sincronizarReserva(tx: Prisma.TransactionClient, reservaId: string, servicio: ServicioFila) {
  const cuenta = await construirCuenta(tx, reservaId, servicio);
  const reserva = await tx.reservation.findUnique({ where: { id: reservaId } });
  if (!reserva) return;
  const data: { montoTotal: number; montoSaldo: number; estado?: "CONFIRMADA" | "PAGADA" } = {
    montoTotal: cuenta.totalConsumido,
    montoSaldo: Math.max(0, cuenta.saldo),
  };
  if (ESTADOS_CON_CUENTA.has(reserva.estado)) data.estado = cuenta.saldo <= 0 ? "PAGADA" : "CONFIRMADA";
  await tx.reservation.update({ where: { id: reservaId }, data });
}

// -- API del servicio --------------------------------------------------------

/**
 * Devuelve la cuenta de la reserva, abriendola (creando las lineas base) si
 * todavia no existia. Es idempotente.
 */
export async function obtenerCuenta(prisma: PrismaClient, codigoPublico: string): Promise<ResultadoCuenta> {
  return prisma.$transaction(async (tx): Promise<ResultadoCuenta> => {
    const reserva = await bloquearYLeerReserva(tx, codigoPublico);
    if (!reserva) return { ok: false, motivo: "NO_ENCONTRADA" };
    if (!ESTADOS_CON_CUENTA.has(reserva.estado)) return { ok: false, motivo: "ESTADO_INVALIDO" };
    const servicio = await cargarServicio(tx, reserva.servicioId);
    if (!servicio) return { ok: false, motivo: "NO_ENCONTRADA" };

    await abrirCuentaSiHaceFalta(tx, reserva);
    return { ok: true, cuenta: await construirCuenta(tx, reserva.id, servicio) };
  });
}

interface ContextoMutacion {
  readonly tx: Prisma.TransactionClient;
  readonly reserva: ReservaFila;
  readonly tarifas: TarifasCuenta;
}

/** Abre la cuenta, aplica `cambiar` y sincroniza los totales de la reserva, todo bajo lock. */
async function mutarCuenta(
  prisma: PrismaClient,
  codigoPublico: string,
  cambiar: (contexto: ContextoMutacion) => Promise<MotivoRechazoCuenta | null>,
): Promise<ResultadoCuenta> {
  return prisma.$transaction(async (tx): Promise<ResultadoCuenta> => {
    const reserva = await bloquearYLeerReserva(tx, codigoPublico);
    if (!reserva) return { ok: false, motivo: "NO_ENCONTRADA" };
    if (!ESTADOS_CON_CUENTA.has(reserva.estado)) return { ok: false, motivo: "ESTADO_INVALIDO" };
    const servicio = await cargarServicio(tx, reserva.servicioId);
    if (!servicio) return { ok: false, motivo: "NO_ENCONTRADA" };

    await abrirCuentaSiHaceFalta(tx, reserva);

    const motivo = await cambiar({ tx, reserva, tarifas: aTarifas(servicio) });
    if (motivo) return { ok: false, motivo };

    await sincronizarReserva(tx, reserva.id, servicio);
    return { ok: true, cuenta: await construirCuenta(tx, reserva.id, servicio) };
  });
}

function validarEntradaLinea(entrada: EntradaLinea): boolean {
  if (!entrada || typeof entrada !== "object") return false;
  switch (entrada.tipo) {
    case "HEAT":
      return (
        esDuracionValida(entrada.duracionMin) &&
        esEnteroPositivo(entrada.personas) &&
        (entrada.precioUnitario === undefined || esPrecioValido(entrada.precioUnitario))
      );
    case "NINO_ACOMPANADO":
      return (
        esEnteroPositivo(entrada.ninos) &&
        esEnteroPositivo(entrada.heats) &&
        (entrada.precioUnitario === undefined || esPrecioValido(entrada.precioUnitario))
      );
    case "AJUSTE":
      return (
        typeof entrada.monto === "number" &&
        Number.isFinite(entrada.monto) &&
        entrada.monto !== 0 &&
        textoValido(entrada.nota)
      );
    default:
      return false;
  }
}

/** Agrega un heat (cambio de duracion, heat extra, subgrupo), ninos acompanantes o un ajuste. */
export async function agregarLinea(
  prisma: PrismaClient,
  codigoPublico: string,
  entrada: EntradaLinea,
  actor?: string,
): Promise<ResultadoCuenta> {
  if (!validarEntradaLinea(entrada)) return { ok: false, motivo: "DATOS_INVALIDOS" };

  return mutarCuenta(prisma, codigoPublico, async ({ tx, reserva, tarifas }) => {
    const base = { reservationId: reserva.id, esBase: false, creadoPor: actor ?? null };
    if (entrada.tipo === "HEAT") {
      const duracion = entrada.duracionMin as DuracionHeat;
      const unitario = redondear(entrada.precioUnitario ?? precioHeat(tarifas, duracion, entrada.personas));
      await tx.consumoReserva.create({
        data: {
          ...base,
          tipo: "HEAT",
          descripcion: descripcionHeat(duracion, false),
          duracionMin: duracion,
          cantidad: entrada.personas,
          precioUnitario: unitario,
          monto: redondear(unitario * entrada.personas),
        },
      });
    } else if (entrada.tipo === "NINO_ACOMPANADO") {
      const unitario = redondear(entrada.precioUnitario ?? tarifas.ninoAcompanado);
      const cantidad = entrada.ninos * entrada.heats;
      await tx.consumoReserva.create({
        data: {
          ...base,
          tipo: "NINO_ACOMPANADO",
          descripcion: descripcionNinos(entrada.ninos, entrada.heats),
          duracionMin: null,
          cantidad,
          precioUnitario: unitario,
          monto: redondear(unitario * cantidad),
        },
      });
    } else {
      const monto = redondear(entrada.monto);
      await tx.consumoReserva.create({
        data: {
          ...base,
          tipo: "AJUSTE",
          descripcion: entrada.nota.trim(),
          duracionMin: null,
          cantidad: 1,
          precioUnitario: monto,
          monto,
        },
      });
    }
    return null;
  });
}

/**
 * Cambia duracion, cantidad, precio unitario o descripcion de una linea. Si es
 * un heat y cambia la duracion o la cantidad sin indicar precio, se vuelve a
 * calcular con la tarifa (que depende del tamano del grupo).
 */
export async function modificarLinea(
  prisma: PrismaClient,
  codigoPublico: string,
  lineaId: string,
  cambios: CambiosLinea,
): Promise<ResultadoCuenta> {
  if (!cambios || typeof cambios !== "object") return { ok: false, motivo: "DATOS_INVALIDOS" };
  if (cambios.duracionMin !== undefined && !esDuracionValida(cambios.duracionMin)) {
    return { ok: false, motivo: "DATOS_INVALIDOS" };
  }
  if (cambios.cantidad !== undefined && !esEnteroPositivo(cambios.cantidad)) {
    return { ok: false, motivo: "DATOS_INVALIDOS" };
  }
  if (
    cambios.precioUnitario !== undefined &&
    !(typeof cambios.precioUnitario === "number" && Number.isFinite(cambios.precioUnitario))
  ) {
    return { ok: false, motivo: "DATOS_INVALIDOS" };
  }
  if (cambios.descripcion !== undefined && !textoValido(cambios.descripcion)) {
    return { ok: false, motivo: "DATOS_INVALIDOS" };
  }

  return mutarCuenta(prisma, codigoPublico, async ({ tx, reserva, tarifas }) => {
    const linea = await tx.consumoReserva.findUnique({ where: { id: lineaId } });
    if (!linea || linea.reservationId !== reserva.id) return "LINEA_NO_ENCONTRADA";

    const esHeat = linea.tipo === "HEAT";
    const esAjuste = linea.tipo === "AJUSTE";
    if (cambios.duracionMin !== undefined && !esHeat) return "DATOS_INVALIDOS";
    if (cambios.cantidad !== undefined && esAjuste) return "DATOS_INVALIDOS";
    if (cambios.precioUnitario !== undefined && cambios.precioUnitario < 0 && !esAjuste) return "DATOS_INVALIDOS";

    const duracion = (cambios.duracionMin ?? linea.duracionMin ?? 15) as DuracionHeat;
    const cantidad = cambios.cantidad ?? linea.cantidad;
    const cambioHeat = esHeat && (cambios.duracionMin !== undefined || cambios.cantidad !== undefined);

    let precioUnitario = Number(linea.precioUnitario);
    if (cambios.precioUnitario !== undefined) precioUnitario = redondear(cambios.precioUnitario);
    else if (cambioHeat) precioUnitario = precioHeat(tarifas, duracion, cantidad);

    let descripcion = linea.descripcion;
    if (cambios.descripcion !== undefined) descripcion = cambios.descripcion.trim();
    else if (cambioHeat) descripcion = descripcionHeat(duracion, linea.esBase);
    else if (linea.tipo === "NINO_ACOMPANADO" && cambios.cantidad !== undefined) {
      descripcion = `Niños acompañantes (${cantidad})`;
    }

    await tx.consumoReserva.update({
      where: { id: linea.id },
      data: {
        descripcion,
        duracionMin: esHeat ? duracion : null,
        cantidad,
        precioUnitario,
        monto: redondear(precioUnitario * cantidad),
      },
    });

    // La linea "reservado" es la cantidad de personas de la reserva: si cambia,
    // la reserva (y lo que se ve en las listas) debe mostrar la cantidad nueva.
    // Con varios heats reservados queda la mayor. No toca HeatAllocation: igual
    // que ajustarAsistentesReales, solo registra quienes realmente son; para
    // mover cupo se usa "Cambiar personas".
    if (linea.esBase && cambios.cantidad !== undefined) {
      const lineas = await tx.consumoReserva.findMany({ where: { reservationId: reserva.id } });
      const reservadas = lineas.filter((l) => l.esBase).map((l) => l.cantidad);
      await tx.reservation.update({
        where: { id: reserva.id },
        data: { cantidadPersonas: Math.max(...reservadas) },
      });
    }
    return null;
  });
}

/** Quita una linea de la cuenta. La ultima linea no se puede quitar. */
export async function eliminarLinea(
  prisma: PrismaClient,
  codigoPublico: string,
  lineaId: string,
): Promise<ResultadoCuenta> {
  return mutarCuenta(prisma, codigoPublico, async ({ tx, reserva }) => {
    const linea = await tx.consumoReserva.findUnique({ where: { id: lineaId } });
    if (!linea || linea.reservationId !== reserva.id) return "LINEA_NO_ENCONTRADA";
    const total = await tx.consumoReserva.count({ where: { reservationId: reserva.id } });
    if (total <= 1) return "ULTIMA_LINEA";
    await tx.consumoReserva.delete({ where: { id: linea.id } });
    return null;
  });
}

/**
 * Registra un cobro en caja por el monto exacto que se recibio, con su metodo.
 * Cuando lo pagado cubre el total consumido, la reserva pasa a PAGADA; si luego
 * se agrega consumo, vuelve a CONFIRMADA con el nuevo saldo.
 */
export async function registrarPago(
  prisma: PrismaClient,
  codigoPublico: string,
  entrada: EntradaPago,
  actor?: string,
): Promise<ResultadoCuenta> {
  const montoValido = typeof entrada?.monto === "number" && Number.isFinite(entrada.monto) && entrada.monto > 0;
  const metodoValido = METODOS_COBRO_CAJA.includes(entrada?.metodo as MetodoCobroCaja);
  const notaValida =
    entrada?.nota === undefined || (typeof entrada.nota === "string" && entrada.nota.trim().length <= LARGO_MAXIMO_TEXTO);
  if (!montoValido || !metodoValido || !notaValida) return { ok: false, motivo: "DATOS_INVALIDOS" };

  return mutarCuenta(prisma, codigoPublico, async ({ tx, reserva }) => {
    const nota = entrada.nota?.trim();
    await tx.payment.create({
      data: {
        reservationId: reserva.id,
        tipo: "SALDO",
        monto: redondear(entrada.monto),
        moneda: reserva.moneda,
        metodo: entrada.metodo,
        estado: "PAGADO",
        pagadoEn: new Date(),
        nota: nota ? nota : null,
        registradoPor: actor ?? null,
      },
    });
    return null;
  });
}

/**
 * Tras subir o bajar la cantidad de personas de una reserva (ver
 * cambio-personas.service.ts y cobro-saldo.service.ts), reajusta las lineas
 * base de la cuenta (respetando su duracion) y vuelve a sincronizar los totales.
 * Si la cuenta nunca se abrio, no hace nada: los montos de la reserva ya son los
 * correctos. Las lineas extra (heats extra, ninos, ajustes) no se tocan.
 * Debe llamarse dentro de la transaccion que cambio la cantidad.
 */
export async function sincronizarCuentaTrasCambioDePersonas(
  tx: Prisma.TransactionClient | PrismaClient,
  reservaId: string,
  nuevaCantidad: number,
): Promise<void> {
  const lineas = await tx.consumoReserva.findMany({ where: { reservationId: reservaId } });
  if (lineas.length === 0) return;

  const reserva = await tx.reservation.findUnique({ where: { id: reservaId } });
  if (!reserva) return;
  const servicio = await cargarServicio(tx, reserva.servicioId);
  if (!servicio) return;
  const tarifas = aTarifas(servicio);

  for (const linea of lineas.filter((l) => l.esBase)) {
    const duracion = (linea.duracionMin ?? 15) as DuracionHeat;
    const precioUnitario = precioHeat(tarifas, duracion, nuevaCantidad);
    await tx.consumoReserva.update({
      where: { id: linea.id },
      data: { cantidad: nuevaCantidad, precioUnitario, monto: redondear(precioUnitario * nuevaCantidad) },
    });
  }

  await sincronizarReserva(tx as Prisma.TransactionClient, reservaId, servicio);
}
