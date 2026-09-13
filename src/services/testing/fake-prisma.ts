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

export interface FilaServicio {
  id: Id;
  moneda: string;
  precioPorPersona: number;
  porcentajeDeposito: number;
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
  participantCount: number;
  estado: EstadoAsignacion;
}

export interface FilaReserva {
  id: Id;
  publicCode: string;
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
  expiraEn: Date | null;
}

let contadorId = 0;
function nuevoId(prefijo: string): string {
  contadorId += 1;
  return `${prefijo}-${contadorId}`;
}

function mismaFecha(a: Date, b: Date): boolean {
  return a.getTime() === b.getTime();
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

  private proximoConflictoUnico: { tabla: "heat" | "reservation"; target: string; vecesRestantes: number } | null =
    null;

  // -- Helpers de fixtures --------------------------------------------------

  crearServicio(datos: { id: Id } & Partial<Omit<FilaServicio, "id">>): FilaServicio {
    const fila: FilaServicio = {
      moneda: "CRC",
      precioPorPersona: 4000,
      porcentajeDeposito: 50,
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
    participantCount: number;
    estado: "CONFIRMADA" | "TEMPORAL" | "PENDIENTE_VALIDACION_SINPE";
    expiraEn?: Date | null;
    servicioId: Id;
    fecha: Date;
  }): { reserva: FilaReserva; asignacion: FilaAsignacion } {
    const reserva: FilaReserva = {
      id: nuevoId("res"),
      publicCode: nuevoId("SRP"),
      servicioId: opciones.servicioId,
      fecha: opciones.fecha,
      cantidadPersonas: opciones.participantCount,
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
      participantCount: opciones.participantCount,
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
    findMany: async ({ where }: { where: { servicioId: Id; fecha: Date } }) =>
      this.excepciones.filter(
        (e) => e.servicioId === where.servicioId && mismaFecha(e.fecha, where.fecha),
      ),
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
  };

  readonly administrativeBlock = {
    findMany: async ({ where }: { where: { servicioId: Id; fecha: Date } }) =>
      this.bloqueos.filter(
        (b) => b.servicioId === where.servicioId && mismaFecha(b.fecha, where.fecha),
      ),
  };

  readonly service = {
    findUnique: async ({ where }: { where: { id: Id } }) =>
      this.servicios.find((s) => s.id === where.id) ?? null,
  };

  readonly heat = {
    findMany: async ({ where }: { where: { servicioId: Id; fecha: Date } }) =>
      this.heats
        .filter((h) => h.servicioId === where.servicioId && mismaFecha(h.fecha, where.fecha))
        .sort((a, b) => a.horaInicio.localeCompare(b.horaInicio))
        .map((h) => ({
          ...h,
          lote: this.lotes.find((l) => l.id === h.loteId)!,
          asignaciones: this.asignaciones
            .filter((a) => a.heatId === h.id && a.estado === "ACTIVA")
            .map((a) => {
              const r = this.reservas.find((res) => res.id === a.reservationId)!;
              return { ...a, reservation: { estado: r.estado, expiraEn: r.expiraEn } };
            }),
        })),
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
  };

  readonly heatAllocation = {
    create: async ({ data }: { data: Omit<FilaAsignacion, "id" | "estado"> }) => {
      const fila: FilaAsignacion = { id: nuevoId("alloc"), estado: "ACTIVA", ...data };
      this.asignaciones.push(fila);
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
    findUnique: async ({ where }: { where: { claveIdempotencia: string } }) => {
      const encontrada = this.reservas.find((r) => r.claveIdempotencia === where.claveIdempotencia) ?? null;
      this.onReservationFindUnique?.();
      return encontrada;
    },
    findUniqueOrThrow: async ({ where }: { where: { claveIdempotencia: string } }) => {
      const fila = this.reservas.find((r) => r.claveIdempotencia === where.claveIdempotencia);
      if (!fila) throw new Error("No encontrado (fake)");
      return fila;
    },
    create: async ({ data }: { data: Omit<FilaReserva, "id"> }) => {
      this.lanzarSiTocaConflicto("reservation");
      const fila: FilaReserva = { id: nuevoId("res"), ...data };
      this.reservas.push(fila);
      return fila;
    },
  };

  /** Ejecuta el callback SIN aislamiento real (no hay otras transacciones
   * concurrentes en este doble de un solo hilo). Sí revierte, de forma
   * best-effort, las filas AGREGADAS durante un intento fallido (trunca
   * cada tabla a su longitud previa), para que un `heat.create` que lanza
   * a mitad de transaccion no deje una `Reservation` huerfana — igual que
   * haria un ROLLBACK real. Limitacion real y deliberada: una mutacion
   * in-place sobre una fila YA EXISTENTE (ej. `operationalBatch.update` al
   * ampliar un lote, 8.3/DISP-015) NO se revierte por este mecanismo; ese
   * escenario de fallo solo esta cubierto por Postgres real (ver
   * availability.service.integration.test.ts). */
  async $transaction<T>(fn: (tx: this) => Promise<T>): Promise<T> {
    const longitudes = {
      servicios: this.servicios.length,
      plantillas: this.plantillas.length,
      excepciones: this.excepciones.length,
      bloqueos: this.bloqueos.length,
      lotes: this.lotes.length,
      heats: this.heats.length,
      asignaciones: this.asignaciones.length,
      reservas: this.reservas.length,
    };
    try {
      return await fn(this);
    } catch (error) {
      this.servicios.length = longitudes.servicios;
      this.plantillas.length = longitudes.plantillas;
      this.excepciones.length = longitudes.excepciones;
      this.bloqueos.length = longitudes.bloqueos;
      this.lotes.length = longitudes.lotes;
      this.heats.length = longitudes.heats;
      this.asignaciones.length = longitudes.asignaciones;
      this.reservas.length = longitudes.reservas;
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
