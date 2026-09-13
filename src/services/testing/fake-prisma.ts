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
  liberadoEn?: Date | null;
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
    /** Filtra por cualquier combinacion de `servicioId`+`fecha` (uso de
     * availability.service.ts, disponibilidad del dia) o `loteId` (uso de
     * expiracion.service.ts, heats de un lote concreto al normalizarlo). */
    findMany: async ({
      where,
    }: {
      where: { servicioId?: Id; fecha?: Date; loteId?: Id };
    }) => {
      let resultado = this.heats.slice();
      if (where.servicioId !== undefined) {
        resultado = resultado.filter((h) => h.servicioId === where.servicioId);
      }
      if (where.fecha !== undefined) {
        resultado = resultado.filter((h) => mismaFecha(h.fecha, where.fecha!));
      }
      if (where.loteId !== undefined) {
        resultado = resultado.filter((h) => h.loteId === where.loteId);
      }
      return resultado
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
        }));
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
  };

  /** Se invoca despues de resolver `reservation.findUnique` (la lectura
   * rapida de idempotencia al inicio de `confirmarReserva`), antes de que el
   * resultado se devuelva. Permite a una prueba insertar la fila "ganadora"
   * de una carrera justo en esa ventana, ANTES de que empiece la
   * transaccion (y por tanto sin que el rollback de `$transaction` la
   * elimine si el intento propio falla). */
  onReservationFindUnique: (() => void) | null = null;

  readonly reservation = {
    findUnique: async ({ where }: { where: { claveIdempotencia?: string; id?: Id } }) => {
      const encontrada =
        this.reservas.find(
          (r) =>
            (where.id !== undefined && r.id === where.id) ||
            (where.claveIdempotencia !== undefined && r.claveIdempotencia === where.claveIdempotencia),
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
