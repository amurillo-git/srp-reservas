// ============================================================================
// Doble de prueba de PrismaClient para availability.service.ts.
//
// NO es un mock generico de Prisma: implementa unicamente las llamadas
// exactas que availability.service.ts hace (un metodo por cada uso real en
// ese archivo), como una base de datos en memoria de un solo hilo.
//
// Limitacion deliberada e importante: `$transaction` aqui NO tiene
// aislamiento real (no hay otras transacciones concurrentes dentro de un
// mismo proceso Node de un solo hilo) — solo revierte, de forma best-effort,
// las filas agregadas durante un intento fallido (ver su comentario) para
// que la logica de reintento de `confirmarReserva` se pueda probar sin dejar
// filas huerfanas. Y `$queryRaw` (SELECT ... FOR UPDATE) no bloquea nada:
// no hay concurrencia real que bloquear. Este doble sirve para probar la
// LOGICA DE CONTROL de availability.service.ts (idempotencia, reintentos
// ante conflicto, clasificacion de bloques del calendario, calculo de
// precio). Las garantias reales de concurrencia (CONC-001, seccion 8.8)
// solo se verifican contra Postgres real: ver
// availability.service.integration.test.ts.
// ============================================================================

import { Prisma } from "@prisma/client";

type Id = string;
type TipoExcepcion = "HABILITADO" | "MODIFICADO" | "CERRADO";
type EstadoAsignacion = "ACTIVA" | "LIBERADA";

export interface FilaUsuario {
  id: Id;
  email: string;
  passwordHash: string;
  rol: string;
  activo: boolean;
}

export interface FilaServicio {
  id: Id;
  nombre: string;
  slug: string;
  moneda: string;
  precioPorPersonaGrupoPequeno: number;
  precioPorPersonaGrupoGrande: number;
  porcentajeDeposito: number;
  activo: boolean;
}

export interface FilaPlantilla {
  id: Id;
  servicioId: Id;
  diaSemana: number;
  horaApertura: string;
  horaCierre: string;
  almuerzoInicio: string | null;
  almuerzoFin: string | null;
  activo: boolean;
}

export interface FilaExcepcion {
  id: Id;
  servicioId: Id;
  fecha: Date;
  tipo: TipoExcepcion;
  horaApertura: string | null;
  horaCierre: string | null;
  almuerzoInicio: string | null;
  almuerzoFin: string | null;
  motivo?: string | null;
}

export interface FilaBloqueo {
  id: Id;
  servicioId: Id;
  fecha: Date;
  horaInicio: string;
  horaFin: string;
  motivo: string | null;
}

export interface FilaLote {
  id: Id;
  servicioId: Id;
  fecha: Date;
  horaInicio: string;
  horaFinUltimoHeat: string;
  horaInicioLimpieza: string;
  horaFinLimpieza: string;
  cantidadHeats: number;
}

export interface FilaHeat {
  id: Id;
  loteId: Id;
  servicioId: Id;
  fecha: Date;
  horaInicio: string;
  horaFin: string;
  posicionEnLote: number;
}

export interface FilaAsignacion {
  id: Id;
  reservationId: Id;
  heatId: Id;
  cantidadParticipantes: number;
  estado: EstadoAsignacion;
  liberadoEn?: Date | null;
}

export interface FilaReserva {
  id: Id;
  codigoPublico: string;
  servicioId: Id;
  fecha: Date;
  cantidadPersonas: number;
  estado: string;
  moneda: string;
  montoTotal: number;
  montoDeposito: number;
  montoSaldo: number;
  claveIdempotencia: string;
  clienteNombre: string;
  clienteTelefono: string;
  clienteEmail?: string | null;
  motivoRechazo?: string | null;
  rechazadaEn?: Date | null;
  confirmadaEn?: Date | null;
  canceladaEn?: Date | null;
  expiraEn: Date | null;
}

/** Forma de los argumentos que `heat.findMany` realmente recibe: de
 * availability.service.ts (`servicioId`+`fecha`, ver
 * `construirContextoDisponibilidad`) y de expiracion.service.ts (`loteId`,
 * ver `normalizarUnLote`). Todo es opcional salvo `where` porque un
 * `include`/`orderBy` ausente es un `findMany` valido (sin relaciones ni
 * orden explicito) tanto en Prisma real como aqui. */
interface ArgsHeatFindMany {
  where: { servicioId?: Id; fecha?: Date; loteId?: Id };
  orderBy?: { horaInicio?: "asc" | "desc"; posicionEnLote?: "asc" | "desc" };
  include?: {
    lote?: boolean;
    asignaciones?: {
      where?: { estado?: EstadoAsignacion };
      include?: { reservation?: { select?: Partial<Record<keyof FilaReserva, boolean>> } };
    };
  };
}

let contadorId = 0;
function nuevoId(prefijo: string): string {
  contadorId += 1;
  return `${prefijo}-${contadorId}`;
}

/** Compara solo año/mes/día (UTC), igual que la semántica real de la columna
 * Postgres `@db.Date`: esta NO guarda hora, asi que dos `Date` con distinta
 * hora pero el mismo dia calendario deben considerarse la misma fecha. Se usa
 * UTC porque `fechaISOaDate` en availability.service.ts construye siempre
 * medianoche UTC (mismo criterio que `Date#getUTCDay()` en el resto del
 * servicio). */
function mismaFecha(a: Date, b: Date): boolean {
  return (
    a.getUTCFullYear() === b.getUTCFullYear() &&
    a.getUTCMonth() === b.getUTCMonth() &&
    a.getUTCDate() === b.getUTCDate()
  );
}

export interface FilaComprobanteSinpe {
  id: Id;
  reservationId: Id;
  comprobanteUrl?: string | null;
  nombrePagador?: string | null;
  numeroOrigen?: string | null;
  referencia?: string | null;
  reportadoEn: Date;
}

export class FakePrisma {
  readonly servicios: FilaServicio[] = [];
  readonly plantillas: FilaPlantilla[] = [];
  readonly excepciones: FilaExcepcion[] = [];
  readonly bloqueos: FilaBloqueo[] = [];
  readonly lotes: FilaLote[] = [];
  readonly heats: FilaHeat[] = [];
  readonly asignaciones: FilaAsignacion[] = [];
  readonly reservas: FilaReserva[] = [];
  readonly comprobantesSinpe: FilaComprobanteSinpe[] = [];
  readonly usuarios: FilaUsuario[] = [];

  private proximoConflictoUnico: { tabla: "heat" | "reservation"; target: string; vecesRestantes: number } | null =
    null;

  // -- Helpers de fixtures --------------------------------------------------

  crearServicio(datos: { id: Id } & Partial<Omit<FilaServicio, "id">>): FilaServicio {
    const fila: FilaServicio = {
      nombre: "Karts",
      slug: `karts-${datos.id}`,
      moneda: "CRC",
      precioPorPersonaGrupoPequeno: 4000,
      precioPorPersonaGrupoGrande: 4000,
      porcentajeDeposito: 50,
      activo: true,
      ...datos,
    };
    this.servicios.push(fila);
    return fila;
  }

  crearPlantilla(
    datos: { id: Id; servicioId: Id; diaSemana: number } & Partial<
      Omit<FilaPlantilla, "id" | "servicioId" | "diaSemana">
    >,
  ): FilaPlantilla {
    const fila: FilaPlantilla = {
      horaApertura: "09:00",
      horaCierre: "16:00",
      almuerzoInicio: "12:00",
      almuerzoFin: "12:30",
      activo: true,
      ...datos,
    };
    this.plantillas.push(fila);
    return fila;
  }

  crearExcepcion(
    datos: { id: Id; servicioId: Id; fecha: Date; tipo: TipoExcepcion } & Partial<
      Omit<FilaExcepcion, "id" | "servicioId" | "fecha" | "tipo">
    >,
  ): FilaExcepcion {
    const fila: FilaExcepcion = {
      horaApertura: null,
      horaCierre: null,
      almuerzoInicio: null,
      almuerzoFin: null,
      ...datos,
    };
    this.excepciones.push(fila);
    return fila;
  }

  crearBloqueo(
    datos: { id: Id; servicioId: Id; fecha: Date; horaInicio: string; horaFin: string } & Partial<
      Pick<FilaBloqueo, "motivo">
    >,
  ): FilaBloqueo {
    const fila: FilaBloqueo = { motivo: null, ...datos };
    this.bloqueos.push(fila);
    return fila;
  }

  crearLote(datos: Omit<FilaLote, never>): FilaLote {
    this.lotes.push(datos);
    return datos;
  }

  crearHeat(datos: Omit<FilaHeat, never>): FilaHeat {
    this.heats.push(datos);
    return datos;
  }

  /** Crea una reserva ya existente junto con su asignacion a un heat, para
   * simular ocupacion previa (6.5). `estado` determina si el motor la
   * contara como confirmada o retenida. */
  crearReservaConAsignacion(opciones: {
    heatId: Id;
    cantidadParticipantes: number;
    estado: "CONFIRMADA" | "TEMPORAL" | "PENDIENTE_VALIDACION_SINPE";
    expiraEn?: Date | null;
    servicioId: Id;
    fecha: Date;
  }): { reserva: FilaReserva; asignacion: FilaAsignacion } {
    const reserva: FilaReserva = {
      id: nuevoId("res"),
      codigoPublico: nuevoId("SRP"),
      servicioId: opciones.servicioId,
      fecha: opciones.fecha,
      cantidadPersonas: opciones.cantidadParticipantes,
      estado: opciones.estado,
      moneda: "CRC",
      montoTotal: 0,
      montoDeposito: 0,
      montoSaldo: 0,
      claveIdempotencia: nuevoId("idem"),
      clienteNombre: "Fixture",
      clienteTelefono: "00000000",
      expiraEn: opciones.expiraEn ?? null,
    };
    this.reservas.push(reserva);
    const asignacion: FilaAsignacion = {
      id: nuevoId("alloc"),
      reservationId: reserva.id,
      heatId: opciones.heatId,
      cantidadParticipantes: opciones.cantidadParticipantes,
      estado: "ACTIVA",
    };
    this.asignaciones.push(asignacion);
    return { reserva, asignacion };
  }

  /** Las proximas `veces` veces que `tabla` intente crear una fila, se lanza
   * un PrismaClientKnownRequestError P2002 con este `target`, simulando
   * 8.8.6 (otra transaccion gano la carrera por un indice unico). Util para
   * probar tanto "un reintento resuelve el conflicto" (veces=1) como "se
   * agotan los reintentos" (veces >= intentosMaximos). */
  forzarConflictoUnico(tabla: "heat" | "reservation", target: string, veces = 1): void {
    this.proximoConflictoUnico = { tabla, target, vecesRestantes: veces };
  }

  private lanzarSiTocaConflicto(tabla: "heat" | "reservation"): void {
    if (this.proximoConflictoUnico && this.proximoConflictoUnico.tabla === tabla) {
      const { target } = this.proximoConflictoUnico;
      this.proximoConflictoUnico.vecesRestantes -= 1;
      if (this.proximoConflictoUnico.vecesRestantes <= 0) {
        this.proximoConflictoUnico = null;
      }
      throw new Prisma.PrismaClientKnownRequestError("Unique constraint failed (simulado)", {
        code: "P2002",
        clientVersion: "test",
        meta: { target },
      });
    }
  }

  // -- Superficie usada por availability.service.ts -------------------------

  readonly scheduleException = {
    /** `where.fecha` acepta una fecha exacta (uso de availability.service.ts,
     * resolverVentanasDelDia) o un rango `{gte, lt}` (uso de
     * horarios.service.ts, listado por mes). */
    findMany: async ({
      where,
    }: {
      where: { servicioId: Id; fecha?: Date | { gte?: Date; lt?: Date } };
    }) =>
      this.excepciones
        .filter((e) => {
          if (e.servicioId !== where.servicioId) return false;
          if (where.fecha === undefined) return true;
          if (where.fecha instanceof Date) return mismaFecha(e.fecha, where.fecha);
          if (where.fecha.gte !== undefined && e.fecha.getTime() < where.fecha.gte.getTime()) return false;
          if (where.fecha.lt !== undefined && e.fecha.getTime() >= where.fecha.lt.getTime()) return false;
          return true;
        })
        .sort((a, b) => a.fecha.getTime() - b.fecha.getTime()),
    create: async ({ data }: { data: Omit<FilaExcepcion, "id"> }) => {
      const fila: FilaExcepcion = { id: nuevoId("exc"), ...data };
      this.excepciones.push(fila);
      return fila;
    },
    delete: async ({ where }: { where: { id: Id } }) => {
      const indice = this.excepciones.findIndex((e) => e.id === where.id);
      if (indice === -1) throw new Error(`Excepcion ${where.id} no existe (fake)`);
      const [fila] = this.excepciones.splice(indice, 1);
      return fila!;
    },
  };

  readonly scheduleTemplate = {
    findUnique: async ({
      where,
    }: {
      where: { servicioId_diaSemana: { servicioId: Id; diaSemana: number } };
    }) =>
      this.plantillas.find(
        (p) =>
          p.servicioId === where.servicioId_diaSemana.servicioId &&
          p.diaSemana === where.servicioId_diaSemana.diaSemana,
      ) ?? null,
    findMany: async ({ where, orderBy }: { where: { servicioId: Id }; orderBy?: { diaSemana?: "asc" | "desc" } }) => {
      const filas = this.plantillas.filter((p) => p.servicioId === where.servicioId);
      const signo = orderBy?.diaSemana === "desc" ? -1 : 1;
      return [...filas].sort((a, b) => signo * (a.diaSemana - b.diaSemana));
    },
    upsert: async ({
      where,
      create,
      update,
    }: {
      where: { servicioId_diaSemana: { servicioId: Id; diaSemana: number } };
      create: Omit<FilaPlantilla, "id">;
      update: Partial<FilaPlantilla>;
    }) => {
      const existente = this.plantillas.find(
        (p) =>
          p.servicioId === where.servicioId_diaSemana.servicioId &&
          p.diaSemana === where.servicioId_diaSemana.diaSemana,
      );
      if (existente) {
        Object.assign(existente, update);
        return existente;
      }
      const fila: FilaPlantilla = { id: nuevoId("tpl"), ...create };
      this.plantillas.push(fila);
      return fila;
    },
  };

  readonly administrativeBlock = {
    findMany: async ({ where }: { where: { servicioId: Id; fecha: Date } }) =>
      this.bloqueos.filter(
        (b) => b.servicioId === where.servicioId && mismaFecha(b.fecha, where.fecha),
      ),
    create: async ({ data }: { data: Omit<FilaBloqueo, "id"> }) => {
      const fila: FilaBloqueo = { id: nuevoId("block"), ...data };
      this.bloqueos.push(fila);
      return fila;
    },
    delete: async ({ where }: { where: { id: Id } }) => {
      const indice = this.bloqueos.findIndex((b) => b.id === where.id);
      if (indice === -1) throw new Error(`Bloqueo ${where.id} no existe (fake)`);
      const [fila] = this.bloqueos.splice(indice, 1);
      return fila!;
    },
  };

  readonly service = {
    findUnique: async ({ where }: { where: { id: Id } }) =>
      this.servicios.find((s) => s.id === where.id) ?? null,
    findMany: async ({ where }: { where?: { activo?: boolean } } = {}) =>
      this.servicios.filter((s) => where?.activo === undefined || s.activo === where.activo),
  };

  readonly heat = {
    /** Filtra por cualquier combinacion de `servicioId`+`fecha` (uso de
     * availability.service.ts, disponibilidad del dia) o `loteId` (uso de
     * expiracion.service.ts, heats de un lote concreto al normalizarlo).
     * A diferencia de una version anterior de este fake (que ignoraba
     * `include`/`orderBy` y siempre re-derivaba por su cuenta el filtro
     * `estado === "ACTIVA"` y la forma de `reservation`), este metodo LEE los
     * argumentos reales que le pasan: si algun dia el llamador deja de pedir
     * `asignaciones.where.estado` o cambia el `select` de `reservation`, este
     * fake deja de fingir un comportamiento que ya no es el real, en vez de
     * seguir devolviendo datos con la forma vieja. */
    findMany: async (args: ArgsHeatFindMany) => {
      const { where, orderBy, include } = args;
      let filas = this.heats.filter(
        (h) =>
          (where.servicioId === undefined || h.servicioId === where.servicioId) &&
          (where.fecha === undefined || mismaFecha(h.fecha, where.fecha)) &&
          (where.loteId === undefined || h.loteId === where.loteId),
      );

      if (orderBy?.posicionEnLote !== undefined) {
        const signo = orderBy.posicionEnLote === "desc" ? -1 : 1;
        filas = [...filas].sort((a, b) => signo * (a.posicionEnLote - b.posicionEnLote));
      } else {
        const signo = orderBy?.horaInicio === "desc" ? -1 : 1;
        filas = [...filas].sort((a, b) => signo * a.horaInicio.localeCompare(b.horaInicio));
      }

      return filas.map((h) => {
        const fila: FilaHeat & { lote?: FilaLote; asignaciones?: unknown[] } = { ...h };

        if (include?.lote) {
          fila.lote = this.lotes.find((l) => l.id === h.loteId)!;
        }

        if (include?.asignaciones) {
          const filtroEstado = include.asignaciones.where?.estado;
          const seleccionReserva = include.asignaciones.include?.reservation?.select;
          fila.asignaciones = this.asignaciones
            .filter((a) => a.heatId === h.id && (filtroEstado === undefined || a.estado === filtroEstado))
            .map((a) => {
              if (!seleccionReserva) return { ...a };
              const r = this.reservas.find((res) => res.id === a.reservationId)!;
              const reservation: Partial<FilaReserva> = {};
              for (const campo of Object.keys(seleccionReserva) as (keyof FilaReserva)[]) {
                if (seleccionReserva[campo]) reservation[campo] = r[campo] as never;
              }
              return { ...a, reservation };
            });
        }

        return fila;
      });
    },
    findUnique: async ({ where }: { where: { id: Id } }) =>
      this.heats.find((h) => h.id === where.id) ?? null,
    create: async ({ data }: { data: Omit<FilaHeat, "id"> }) => {
      this.lanzarSiTocaConflicto("heat");
      const fila: FilaHeat = { id: nuevoId("heat"), ...data };
      this.heats.push(fila);
      return fila;
    },
    update: async ({ where, data }: { where: { id: Id }; data: Partial<FilaHeat> }) => {
      const fila = this.heats.find((h) => h.id === where.id);
      if (!fila) throw new Error(`Heat ${where.id} no existe (fake)`);
      Object.assign(fila, data);
      return fila;
    },
    /** Simula `onDelete: Cascade` de `HeatAllocation.heat` (schema.prisma):
     * borra tambien cualquier asignacion que quedara apuntando a este heat. */
    delete: async ({ where }: { where: { id: Id } }) => {
      const indice = this.heats.findIndex((h) => h.id === where.id);
      if (indice === -1) throw new Error(`Heat ${where.id} no existe (fake)`);
      const [fila] = this.heats.splice(indice, 1);
      for (let i = this.asignaciones.length - 1; i >= 0; i--) {
        if (this.asignaciones[i]!.heatId === where.id) this.asignaciones.splice(i, 1);
      }
      return fila!;
    },
  };

  readonly operationalBatch = {
    create: async ({ data }: { data: Omit<FilaLote, "id"> }) => {
      const fila: FilaLote = { id: nuevoId("lote"), ...data };
      this.lotes.push(fila);
      return fila;
    },
    update: async ({ where, data }: { where: { id: Id }; data: Partial<FilaLote> }) => {
      const fila = this.lotes.find((l) => l.id === where.id);
      if (!fila) throw new Error(`Lote ${where.id} no existe (fake)`);
      Object.assign(fila, data);
      return fila;
    },
    /** Simula `onDelete: Cascade` de `Heat.lote` (schema.prisma): borra sus
     * heats (y, por extension, las asignaciones de cada uno). */
    delete: async ({ where }: { where: { id: Id } }) => {
      const indice = this.lotes.findIndex((l) => l.id === where.id);
      if (indice === -1) throw new Error(`Lote ${where.id} no existe (fake)`);
      const [fila] = this.lotes.splice(indice, 1);
      const heatIdsDelLote = this.heats.filter((h) => h.loteId === where.id).map((h) => h.id);
      for (const heatId of heatIdsDelLote) {
        await this.heat.delete({ where: { id: heatId } });
      }
      return fila!;
    },
  };

  readonly heatAllocation = {
    findMany: async ({
      where,
    }: {
      where: { reservationId: Id; estado?: EstadoAsignacion };
    }) =>
      this.asignaciones.filter(
        (a) => a.reservationId === where.reservationId && (where.estado === undefined || a.estado === where.estado),
      ),
    updateMany: async ({
      where,
      data,
    }: {
      where: { reservationId: Id; estado?: EstadoAsignacion };
      data: Partial<FilaAsignacion>;
    }) => {
      let contador = 0;
      for (const asignacion of this.asignaciones) {
        if (
          asignacion.reservationId === where.reservationId &&
          (where.estado === undefined || asignacion.estado === where.estado)
        ) {
          Object.assign(asignacion, data);
          contador += 1;
        }
      }
      return { count: contador };
    },
    create: async ({ data }: { data: Omit<FilaAsignacion, "id" | "estado"> }) => {
      const fila: FilaAsignacion = { id: nuevoId("alloc"), estado: "ACTIVA", ...data };
      this.asignaciones.push(fila);
      return fila;
    },
    /** Actualizacion puntual por id (uso de gestion-reservas.service.ts al
     * reprogramar, 14.6: libera EXACTAMENTE las asignaciones anteriores, no
     * todas las ACTIVA de la reserva — esas ya incluyen las nuevas). */
    update: async ({ where, data }: { where: { id: Id }; data: Partial<FilaAsignacion> }) => {
      const fila = this.asignaciones.find((a) => a.id === where.id);
      if (!fila) throw new Error(`HeatAllocation ${where.id} no existe (fake)`);
      Object.assign(fila, data);
      return fila;
    },
  };

  /** Se invoca despues de resolver `reservation.findUnique` (la lectura
   * rapida de idempotencia al inicio de `confirmarReserva`), antes de que el
   * resultado se devuelva. Permite a una prueba insertar la fila "ganadora"
   * de una carrera justo en esa ventana, ANTES de que empiece la
   * transaccion (y por tanto sin que el rollback de `$transaction` la
   * elimine si el intento propio falla). */
  onReservationFindUnique: (() => void) | null = null;

  readonly reservation = {
    findUnique: async ({
      where,
    }: {
      where: { claveIdempotencia?: string; id?: Id; codigoPublico?: string };
    }) => {
      const encontrada =
        this.reservas.find(
          (r) =>
            (where.id !== undefined && r.id === where.id) ||
            (where.claveIdempotencia !== undefined && r.claveIdempotencia === where.claveIdempotencia) ||
            (where.codigoPublico !== undefined && r.codigoPublico === where.codigoPublico),
        ) ?? null;
      this.onReservationFindUnique?.();
      return encontrada;
    },
    findUniqueOrThrow: async ({ where }: { where: { claveIdempotencia: string } }) => {
      const fila = this.reservas.find((r) => r.claveIdempotencia === where.claveIdempotencia);
      if (!fila) throw new Error("No encontrado (fake)");
      return fila;
    },
    /** Filtra por `estado` y, opcionalmente, `expiraEn: { lte }` (uso de
     * expiracion.service.ts para encontrar reservas TEMPORAL vencidas, 19.1). */
    findMany: async ({
      where,
    }: {
      where: { estado: string; expiraEn?: { lte: Date } };
    }) =>
      this.reservas.filter((r) => {
        if (r.estado !== where.estado) return false;
        if (where.expiraEn?.lte !== undefined) {
          if (r.expiraEn === null || r.expiraEn.getTime() > where.expiraEn.lte.getTime()) return false;
        }
        return true;
      }),
    update: async ({ where, data }: { where: { id: Id }; data: Partial<FilaReserva> }) => {
      const fila = this.reservas.find((r) => r.id === where.id);
      if (!fila) throw new Error(`Reservation ${where.id} no existe (fake)`);
      Object.assign(fila, data);
      return fila;
    },
    create: async ({ data }: { data: Omit<FilaReserva, "id"> }) => {
      this.lanzarSiTocaConflicto("reservation");
      const fila: FilaReserva = { id: nuevoId("res"), ...data };
      this.reservas.push(fila);
      return fila;
    },
  };

  readonly sinpeEvidence = {
    findUnique: async ({ where }: { where: { reservationId: Id } }) =>
      this.comprobantesSinpe.find((c) => c.reservationId === where.reservationId) ?? null,
    create: async ({ data }: { data: Omit<FilaComprobanteSinpe, "id" | "reportadoEn"> & { reportadoEn?: Date } }) => {
      const fila: FilaComprobanteSinpe = { id: nuevoId("sinpe"), reportadoEn: data.reportadoEn ?? new Date(), ...data };
      this.comprobantesSinpe.push(fila);
      return fila;
    },
  };

  readonly user = {
    findUnique: async ({ where }: { where: { email: string } }) =>
      this.usuarios.find((u) => u.email === where.email) ?? null,
    findFirst: async () => this.usuarios[0] ?? null,
    create: async ({ data }: { data: Omit<FilaUsuario, "id" | "rol" | "activo"> & { rol?: string; activo?: boolean } }) => {
      const fila: FilaUsuario = { id: nuevoId("user"), rol: "ATENCION", activo: true, ...data };
      this.usuarios.push(fila);
      return fila;
    },
  };

  /** Fixture: agrega un usuario ya creado (sin pasar por `hashearContrasena`
   * real de auth.service.ts, para pruebas que solo necesitan un login exitoso
   * con un hash predecible). */
  crearUsuario(datos: { id: Id; email: string; passwordHash: string } & Partial<Pick<FilaUsuario, "rol" | "activo">>): FilaUsuario {
    const fila: FilaUsuario = { rol: "ATENCION", activo: true, ...datos };
    this.usuarios.push(fila);
    return fila;
  }

  /** Ejecuta el callback SIN aislamiento real (no hay otras transacciones
   * concurrentes en este doble de un solo hilo). Sí revierte, de forma
   * best-effort, los cambios de FILAS (creadas o eliminadas) durante un
   * intento fallido, restaurando cada tabla a una copia superficial de su
   * contenido previo — para que un `heat.create`/`heat.delete` que lanza a
   * mitad de transaccion no deje una `Reservation` huerfana ni arrays
   * corruptos, igual que haria un ROLLBACK real. (Version anterior: solo
   * truncaba por longitud, lo cual restauraba bien los `create` pero dejaba
   * huecos si algo se habia borrado con `splice` — `heat.delete` /
   * `operationalBatch.delete` — antes del error; una copia del contenido
   * evita ese problema). Limitacion real y deliberada que SIGUE sin
   * cubrirse: una mutacion in-place sobre una fila ya existente que no se
   * borra (ej. `operationalBatch.update` al ampliar un lote, 8.3/DISP-015)
   * no se revierte, porque la copia superficial conserva la MISMA
   * referencia de objeto que la mutacion modifico. Ese escenario de fallo
   * solo esta cubierto por Postgres real (ver
   * availability.service.integration.test.ts). */
  async $transaction<T>(fn: (tx: this) => Promise<T>): Promise<T> {
    const copia = {
      servicios: [...this.servicios],
      plantillas: [...this.plantillas],
      excepciones: [...this.excepciones],
      bloqueos: [...this.bloqueos],
      lotes: [...this.lotes],
      heats: [...this.heats],
      asignaciones: [...this.asignaciones],
      reservas: [...this.reservas],
      comprobantesSinpe: [...this.comprobantesSinpe],
      usuarios: [...this.usuarios],
    };
    try {
      return await fn(this);
    } catch (error) {
      this.servicios.splice(0, this.servicios.length, ...copia.servicios);
      this.plantillas.splice(0, this.plantillas.length, ...copia.plantillas);
      this.excepciones.splice(0, this.excepciones.length, ...copia.excepciones);
      this.bloqueos.splice(0, this.bloqueos.length, ...copia.bloqueos);
      this.lotes.splice(0, this.lotes.length, ...copia.lotes);
      this.heats.splice(0, this.heats.length, ...copia.heats);
      this.asignaciones.splice(0, this.asignaciones.length, ...copia.asignaciones);
      this.reservas.splice(0, this.reservas.length, ...copia.reservas);
      this.comprobantesSinpe.splice(0, this.comprobantesSinpe.length, ...copia.comprobantesSinpe);
      this.usuarios.splice(0, this.usuarios.length, ...copia.usuarios);
      throw error;
    }
  }

  /** Se invoca en cada llamada a `$queryRaw` (es decir, cada vez que
   * `bloquearFilasInvolucradas` "toma el lock" de una ronda de
   * `calcularYBloquearPlanFinal`). Permite a una prueba mutar el estado del
   * fake justo en ese punto, para simular que otra transaccion escribio
   * entre la lectura especulativa y el lock, y asi ejercitar rondas de
   * estabilizacion 2+ de forma determinista (ver disponibility.service.test.ts). */
  onQueryRaw: (() => void) | null = null;

  /** No bloquea nada: no hay concurrencia real dentro de este doble de un
   * solo hilo. No-op deliberado (ver cabecera del archivo), salvo por el
   * hook `onQueryRaw` que una prueba puede instalar. */
  async $queryRaw(..._args: unknown[]): Promise<unknown[]> {
    this.onQueryRaw?.();
    return [];
  }
}
