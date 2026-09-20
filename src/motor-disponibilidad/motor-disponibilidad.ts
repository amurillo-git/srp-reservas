// ============================================================================
// Motor de disponibilidad — contratos (tipos + firma pública)
// Referencias entre parentesis: secciones de propuesta.md
//
// Este archivo define UNICAMENTE tipos y la firma de `construirPlan`. El
// algoritmo (busqueda de plan continuo, division en lotes, backtracking) se
// implementa en la Etapa 2 y no vive aqui todavia.
//
// El motor es una funcion pura: no hace I/O ni consultas a base de datos
// (8.6: "La funcion usada para consultar el calendario no debe guardar
// cambios definitivos. Debe construir una propuesta."). Toda la informacion
// del dia llega ya resuelta en el parametro `contexto`.
// ============================================================================

// ----------------------------------------------------------------------------
// 1. Alias de fecha y hora
// ----------------------------------------------------------------------------

/**
 * Fecha en formato `YYYY-MM-DD`, zona horaria local del parque (sin
 * componente de hora). Se usa alias en vez de `Date` porque el motor solo
 * compara bloques discretos ya resueltos, nunca hace aritmetica de calendario.
 */
export type FechaISO = string;

/**
 * Hora en formato `HH:mm` (24 horas), siempre alineada a la grilla de bloques
 * de 15 minutos (minutos en {00, 15, 30, 45}). El motor asume que quien arma
 * `ContextoDisponibilidad` ya garantiza esta alineacion (6.1.1); no la valida.
 */
export type HoraISO = string;

// ----------------------------------------------------------------------------
// 2. Identificadores
// ----------------------------------------------------------------------------
// Alias simples (sin branding): el blueprint no pidio tipos nominales para
// ids, solo para fecha/hora. Mantenerlos como `string` evita complejidad que
// no se pidio explicitamente.

export type IdServicio = string;
export type IdHeat = string;
export type IdLote = string; // corresponde a OperationalBatch (16.4)
export type IdBloqueoAdministrativo = string; // corresponde a AdministrativeBlock (16.1)

// ----------------------------------------------------------------------------
// 3. Constantes operativas del MVP (6.1)
// ----------------------------------------------------------------------------
// Duracion de bloque y capacidad de heat son fijas en el MVP (no configurables
// segun 6.1); se documentan como constantes en vez de parametros de entrada
// para no sobre-disenar el contrato.

export const DURACION_BLOQUE_MINUTOS = 15;
export const CAPACIDAD_MAXIMA_POR_HEAT = 5;

// ----------------------------------------------------------------------------
// 4. Tipos de bloque de calendario (8.2)
// ----------------------------------------------------------------------------
// El blueprint define SEIS estados operativos por bloque de 15 minutos, no
// cuatro. Se incluyen los 6 (no solo Disponible/Heat/Limpieza/Almuerzo que
// menciono el usuario en su mensaje) porque:
//   - "Bloqueado" es indispensable para las reglas 6.6 (division en lotes por
//     eventos privados/mantenimiento) y 8.3 (condiciones para crear un lote).
//   - "Cerrado" es indispensable para 6.4 (restricciones de apertura/cierre).
// Sin estos dos el motor no podria razonar sobre el dia completo. Si el
// usuario de verdad solo quiere 4, este es el punto exacto del contrato a
// recortar (quitar `BloqueBloqueado` y `BloqueCerrado` del union de abajo).

interface BloqueBase {
  readonly fecha: FechaISO;
  readonly horaInicio: HoraISO;
  /** horaInicio + 15 minutos; se guarda explicito para no recalcularlo en cada lectura. */
  readonly horaFin: HoraISO;
}

/** Puede formar parte de un lote nuevo o de la ampliacion valida de un lote (8.2). */
export interface BloqueDisponible extends BloqueBase {
  readonly tipo: "disponible";
}

/** Heat existente; puede aceptar otra reserva mientras conserve capacidad (8.2, 8.4). */
export interface BloqueHeat extends BloqueBase {
  readonly tipo: "heat";
  readonly heatId: IdHeat;
  readonly loteId: IdLote;
  /** Posicion 1-based dentro del lote; sirve para verificar consecutividad (6.1.12). */
  readonly posicionEnLote: number;
  readonly personasConfirmadas: number;
  readonly personasRetenidas: number;
  /** 0..5 = personasConfirmadas + personasRetenidas (6.5). */
  readonly capacidadOcupada: number;
}

/** Bloque global inmediatamente posterior al ultimo heat de un lote (6.1.6-7). */
export interface BloqueLimpieza extends BloqueBase {
  readonly tipo: "limpieza";
  readonly loteId: IdLote;
}

/** Periodo reservado para el personal (6.2, 6.3); igual en todo el dia. */
export interface BloqueAlmuerzo extends BloqueBase {
  readonly tipo: "almuerzo";
}

/** Evento privado, mantenimiento u otra restriccion administrativa (6.6). */
export interface BloqueBloqueado extends BloqueBase {
  readonly tipo: "bloqueado";
  readonly idBloqueoAdministrativo: IdBloqueoAdministrativo;
  /** Motivo legible opcional, ej. "Evento privado", "Mantenimiento". */
  readonly motivo?: string;
}

/** Fuera del horario operativo vigente para la fecha (6.4). */
export interface BloqueCerrado extends BloqueBase {
  readonly tipo: "cerrado";
}

export type BloqueDeCalendario =
  | BloqueDisponible
  | BloqueHeat
  | BloqueLimpieza
  | BloqueAlmuerzo
  | BloqueBloqueado
  | BloqueCerrado;

// ----------------------------------------------------------------------------
// 5. Rejilla del dia y contexto de disponibilidad
// ----------------------------------------------------------------------------

/**
 * Un elemento por cada bloque de 15 minutos del dia completo (incluye los
 * bloques "cerrado" antes de apertura y despues de cierre), ordenados
 * cronologicamente. Todos los bloques corresponden a la misma `fecha` de la
 * solicitud: el MVP no admite reservas repartidas entre fechas (6.1.14).
 */
export type RejillaDelDia = readonly BloqueDeCalendario[];

/** Grupos de 5 personas o mas pagan la tarifa grupal (mas economica). */
export const UMBRAL_GRUPO_GRANDE = 5;

/** Tarifa opcional del servicio; puede no existir aun (8.1). Precio
 * escalonado por tamano de grupo: 1-4 personas pagan
 * `precioPorPersonaGrupoPequeno`, `UMBRAL_GRUPO_GRANDE` o mas pagan
 * `precioPorPersonaGrupoGrande` (tarifa de grupo, mas economica). */
export interface TarifaServicio {
  readonly servicioId: IdServicio;
  /** Moneda ISO 4217, ej. "CRC", "USD". */
  readonly moneda: string;
  readonly precioPorPersonaGrupoPequeno: number;
  readonly precioPorPersonaGrupoGrande: number;
  /** Porcentaje de deposito, 0-100 (MVP = 50, ver 6.7.4). */
  readonly porcentajeDeposito: number;
}

/**
 * Snapshot del dia ya resuelto por la capa que llama al motor (sin I/O
 * dentro de `construirPlan`). Es la unica fuente de verdad sobre heats,
 * lotes, almuerzo, bloqueos y cierre existentes.
 */
export interface ContextoDisponibilidad {
  readonly rejilla: RejillaDelDia;
  /** Ausente si el servicio aun no tiene tarifa configurada. */
  readonly tarifa?: TarifaServicio;
}

// ----------------------------------------------------------------------------
// 6. Distribucion equitativa (7.2)
// ----------------------------------------------------------------------------

/**
 * Vector de personas asignadas por heat, en el orden en que se ubicarian.
 *
 * Invariante semantica (TypeScript no puede expresarla en el tipo, debe
 * validarse en tiempo de ejecucion / pruebas):
 *   - suma(vector) === cantidadPersonas de la solicitud
 *   - cada elemento esta en [1, CAPACIDAD_MAXIMA_POR_HEAT]
 *   - max(vector) - min(vector) <= 1 (7.2; ej. 7 personas => [4,3] o [3,4], nunca [5,2])
 */
export type VectorDistribucion = readonly number[];

// ----------------------------------------------------------------------------
// 7. Entrada de construirPlan (8.1, 8.6)
// ----------------------------------------------------------------------------

export interface SolicitudConstruirPlan {
  readonly fecha: FechaISO;
  /** Hora candidata para el primer heat de la reserva. */
  readonly horaInicioCandidata: HoraISO;
  /** Entero positivo; sin techo comercial en el MVP (6.1.15). */
  readonly cantidadPersonas: number;
  /** 8.1: "Servicio, inicialmente karts". El pseudocodigo de 8.6 lo omite por
   * simplicidad, pero 8.1 lo exige explicitamente como entrada minima. */
  readonly servicioId: IdServicio;
  /** Snapshot del dia ya resuelto; ver ContextoDisponibilidad. */
  readonly contexto: ContextoDisponibilidad;
}

// ----------------------------------------------------------------------------
// 8. Salida de construirPlan (8.1, 8.5, 8.6)
// ----------------------------------------------------------------------------

export interface HeatPropuesto {
  /** null = heat nuevo, aun no creado en base de datos. */
  readonly heatId: IdHeat | null;
  readonly horaInicio: HoraISO;
  readonly horaFin: HoraISO;
  readonly personasAsignadas: number;
  /** true si se reutiliza capacidad de un heat existente (8.4, DISP-005). */
  readonly esHeatReutilizado: boolean;
  /** Capacidad libre en ese heat antes de esta asignacion; util para trazabilidad de por que cupo o no (6.5). */
  readonly capacidadDisponibleAntes: number;
}

export interface LotePropuesto {
  /** null = lote nuevo, aun no creado en base de datos. */
  readonly loteId: IdLote | null;
  /** true si se amplia un lote existente moviendo su limpieza (8.3, DISP-015). */
  readonly esLoteReutilizado: boolean;
  /** Heats consecutivos, en orden ascendente (6.1.12). */
  readonly heats: readonly HeatPropuesto[];
  /** Inicio del primer heat del lote. */
  readonly horaInicio: HoraISO;
  /** Fin del ultimo heat del lote; NO incluye limpieza (glosario "Fin de actividad del cliente"). */
  readonly horaFinActividadCliente: HoraISO;
  /** Fin del bloque de limpieza de este lote. */
  readonly horaFinLimpieza: HoraISO;
}

/** Capacidad que se retendria en un heat concreto si se confirma esta reserva (8.1, 8.8). */
export interface RetencionDeCapacidad {
  /** null si corresponde a un heat que aun no existe (se crearia junto con la reserva). */
  readonly heatId: IdHeat | null;
  readonly loteId: IdLote | null;
  readonly personas: number;
}

/** Presente solo si `ContextoDisponibilidad.tarifa` existe para el servicio (8.1). */
export interface PrecioPropuesto {
  readonly moneda: string;
  readonly montoTotal: number;
  readonly montoDeposito: number;
  readonly montoSaldo: number;
}

/**
 * Motivo de rechazo de alto nivel. Deliberadamente pequeño: el blueprint no
 * pide un catalogo por caso de prueba, solo pistas de por que una hora no
 * se ofrece (8.3, 8.5 punto 12, 6.3, 6.4). `detalle` permite un texto legible
 * adicional sin ampliar el enum.
 */
export type MotivoNoDisponible =
  /** No existe una secuencia de heats consecutivos con capacidad suficiente
   * a partir de la hora candidata (8.4, 8.5 pasos 3-6; ej. DISP-006). */
  | "SIN_HEATS_CONSECUTIVOS_DISPONIBLES"
  /** El lote o su limpieza chocarian con almuerzo, un bloqueo administrativo,
   * un heat existente o el cierre (8.2, 8.3, 6.3, 6.4; ej. DISP-007, 008, 010). */
  | "CRUCE_CON_BLOQUE_NO_DISPONIBLE"
  /** Se agotaron las divisiones posibles en lotes y la reserva no cabe ese
   * dia (8.5 punto 12, 8.6 "retornar sin disponibilidad"). */
  | "NO_COMPLETA_EN_EL_DIA";

export interface PlanDisponible {
  readonly disponible: true;
  readonly cantidadLotes: number;
  /** Vector de distribucion equitativa usado para toda la reserva (7.2). */
  readonly distribucion: VectorDistribucion;
  readonly lotes: readonly LotePropuesto[];
  /** Fin del ultimo heat de TODA la reserva (todos los lotes), sin limpieza. */
  readonly horaFinActividadCliente: HoraISO;
  /** Fin de la limpieza del ultimo lote; uso interno para disponibilidad (glosario "Liberacion operativa"). */
  readonly liberacionOperativa: HoraISO;
  readonly capacidadesRetenidas: readonly RetencionDeCapacidad[];
  /** Ausente si el servicio aun no tiene tarifa configurada. */
  readonly precio?: PrecioPropuesto;
}

export interface PlanNoDisponible {
  readonly disponible: false;
  readonly motivo: MotivoNoDisponible;
  /** Texto legible opcional para soporte/depuracion, no para reglas de negocio. */
  readonly detalle?: string;
}

export type PlanDisponibilidad = PlanDisponible | PlanNoDisponible;

// ----------------------------------------------------------------------------
// 9. Firma publica
// ----------------------------------------------------------------------------

/**
 * Construye —sin persistir nada— la propuesta de heats/lotes para una
 * solicitud de reserva a partir de una hora candidata concreta.
 *
 * Es una funcion pura y deterministica: la misma `solicitud` siempre produce
 * el mismo resultado. No consulta la base de datos ni hace ningun tipo de
 * E/S; toda la informacion del dia llega resuelta en `solicitud.contexto`
 * (8.6: "La funcion usada para consultar el calendario no debe guardar
 * cambios definitivos. Debe construir una propuesta."). La creacion real de
 * la reserva revalida este mismo calculo dentro de una transaccion aparte
 * que si bloquea capacidad (8.8).
 *
 * @param solicitud fecha, hora candidata, cantidad de personas, servicio y
 *   snapshot del dia (8.1, 8.6).
 * @returns un plan disponible con lotes/heats/precio propuestos, o un plan no
 *   disponible con un motivo de rechazo de alto nivel (8.5 punto 12).
 */
export function construirPlan(
  solicitud: SolicitudConstruirPlan,
): PlanDisponibilidad {
  const { contexto, cantidadPersonas, horaInicioCandidata } = solicitud;
  const mapaBloques = indexarRejillaPorInicio(contexto.rejilla);
  const minutoMaximo = calcularMinutoMaximo(mapaBloques);
  const inicioMin = horaAMinutos(horaInicioCandidata);

  const heats = Math.ceil(cantidadPersonas / CAPACIDAD_MAXIMA_POR_HEAT);
  const distribucion = distribuirEquilibradamente(cantidadPersonas, heats);

  // 1) Plan continuo: todos los heats + una sola limpieza, empezando
  //    exactamente en la hora candidata (8.5 pasos 3-6, 8.6).
  const planContinuo = buscarEnPosicionFija(mapaBloques, inicioMin, distribucion);
  if (planContinuo.exito) {
    return construirPlanDisponible([planContinuo.lote], cantidadPersonas, contexto);
  }

  // 2) Hasta 15 personas: un solo lote es obligatorio (6.1.8); si no cabe, se
  //    rechaza la hora candidata (8.5 paso 7).
  if (cantidadPersonas <= 15) {
    return { disponible: false, motivo: planContinuo.motivo };
  }

  // 3) Mas de 15 personas: probar 2, 3, ... lotes (8.5 pasos 8-9, 8.6).
  for (let cantidadLotes = 2; cantidadLotes <= heats; cantidadLotes++) {
    const composiciones = generarComposiciones(heats, cantidadLotes);
    const candidatos: (readonly LotePropuesto[])[] = [];

    for (const composicion of composiciones) {
      const chunks = dividirEnChunks(distribucion, composicion);
      const resultado = buscarLotesEnOrden(mapaBloques, minutoMaximo, inicioMin, chunks);
      if (resultado.exito) {
        candidatos.push(resultado.lotes);
      }
    }

    // Se retorna en el primer nivel de cantidadLotes con al menos un
    // candidato: garantiza "menor cantidad de lotes" (8.6, criterio 1).
    if (candidatos.length > 0) {
      const mejor = [...candidatos].sort(compararPlanesLote)[0]!;
      return construirPlanDisponible(mejor, cantidadPersonas, contexto);
    }
  }

  return { disponible: false, motivo: "NO_COMPLETA_EN_EL_DIA" };
}

// ----------------------------------------------------------------------------
// 10. Implementacion interna (Etapa 2)
// ----------------------------------------------------------------------------
// Funciones internas (no exportadas). Usan aritmetica de minutos-desde-
// medianoche solo para COMPARAR/SUMAR horas; las horas que se devuelven en el
// resultado siempre se copian de bloques ya existentes en la rejilla, nunca
// se sintetiza un HoraISO nuevo desde minutos.

/** "HH:mm" -> minutos desde medianoche. */
export function horaAMinutos(hora: HoraISO): number {
  const partes = hora.split(":").map(Number);
  return partes[0]! * 60 + partes[1]!;
}

/** Inverso de `horaAMinutos`. Se exporta junto a ella como unica fuente de
 * verdad para esta conversion: `availability.service.ts` la necesita para
 * construir la rejilla del dia desde la base de datos, y los tests para
 * construir contextos sinteticos; el motor mismo nunca la usa (nunca
 * sintetiza un HoraISO nuevo, siempre copia horas ya existentes en la
 * rejilla). Mantenerla aqui evita que las copias diverjan en silencio. */
export function minutosAHora(minutos: number): HoraISO {
  const h = Math.floor(minutos / 60).toString().padStart(2, "0");
  const m = (minutos % 60).toString().padStart(2, "0");
  return `${h}:${m}`;
}

/** Indexa la rejilla del dia por minuto de inicio para acceso O(1) por slot. */
function indexarRejillaPorInicio(rejilla: RejillaDelDia): Map<number, BloqueDeCalendario> {
  const mapa = new Map<number, BloqueDeCalendario>();
  for (const bloque of rejilla) {
    mapa.set(horaAMinutos(bloque.horaInicio), bloque);
  }
  return mapa;
}

/** Ultimo minuto de inicio presente en la rejilla (limite de busqueda hacia adelante). */
function calcularMinutoMaximo(mapaBloques: Map<number, BloqueDeCalendario>): number {
  let maximo = -Infinity;
  for (const minuto of mapaBloques.keys()) {
    if (minuto > maximo) maximo = minuto;
  }
  return maximo;
}

/** Vector de distribucion equitativa (7.2): los primeros `residuo` heats
 * reciben `base + 1` personas, el resto recibe `base`. */
function distribuirEquilibradamente(personas: number, heats: number): VectorDistribucion {
  const base = Math.floor(personas / heats);
  const residuo = personas % heats;
  const vector: number[] = [];
  for (let i = 0; i < heats; i++) {
    vector.push(i < residuo ? base + 1 : base);
  }
  return vector;
}

/** Cache de `permutacionesUnicas` por vector de entrada: el dropdown publico
 * (8.7) evalua ~96 candidatos por dia para el mismo (servicioId, fecha,
 * cantidadPersonas), y todos ellos derivan el MISMO vector de distribucion
 * (7.2) desde `construirPlan` — recalcular sus permutaciones en cada uno es
 * trabajo repetido y determinista. Clave = vector serializado; el resultado
 * de `permutacionesUnicas` es puro (solo depende de `valores`), asi que
 * cachear por su contenido es seguro. */
const cachePermutaciones = new Map<string, number[][]>();

/** Todas las permutaciones UNICAS de `valores` (evita duplicados con
 * elementos repetidos, ej. [5,5,5]). El orden original se prueba primero
 * (8.5 paso 4: se permutan solo "cuando sea necesario"). */
function permutacionesUnicas(valores: readonly number[]): number[][] {
  const claveCache = valores.join(",");
  const cacheada = cachePermutaciones.get(claveCache);
  if (cacheada) return cacheada;

  const conteos = new Map<number, number>();
  for (const v of valores) conteos.set(v, (conteos.get(v) ?? 0) + 1);
  const claves = [...conteos.keys()].sort((a, b) => b - a);

  const resultado: number[][] = [];
  const actual: number[] = [];

  function backtrack(): void {
    if (actual.length === valores.length) {
      resultado.push([...actual]);
      return;
    }
    for (const clave of claves) {
      const disponibles = conteos.get(clave) ?? 0;
      if (disponibles > 0) {
        conteos.set(clave, disponibles - 1);
        actual.push(clave);
        backtrack();
        actual.pop();
        conteos.set(clave, disponibles);
      }
    }
  }
  backtrack();

  const indiceIdentidad = resultado.findIndex((permutacion) =>
    permutacion.every((valor, i) => valor === valores[i]!),
  );
  if (indiceIdentidad > 0) {
    const identidad = resultado.splice(indiceIdentidad, 1)[0]!;
    resultado.unshift(identidad);
  }
  cachePermutaciones.set(claveCache, resultado);
  return resultado;
}

/** Todas las composiciones ordenadas de `total` en exactamente `partes` enteros positivos. */
function generarComposiciones(total: number, partes: number): number[][] {
  if (partes === 1) return [[total]];
  const resultado: number[][] = [];
  for (let primero = 1; primero <= total - (partes - 1); primero++) {
    for (const resto of generarComposiciones(total - primero, partes - 1)) {
      resultado.push([primero, ...resto]);
    }
  }
  return resultado;
}

/** Corta `distribucion` en tramos contiguos segun una composicion de tamanos. */
function dividirEnChunks(
  distribucion: VectorDistribucion,
  composicion: readonly number[],
): number[][] {
  const chunks: number[][] = [];
  let indice = 0;
  for (const tamano of composicion) {
    chunks.push(distribucion.slice(indice, indice + tamano));
    indice += tamano;
  }
  return chunks;
}

type ResultadoColocacion =
  | { readonly exito: true; readonly lote: LotePropuesto }
  | { readonly exito: false; readonly motivo: MotivoNoDisponible };

type ResultadoLotesEnOrden =
  | { readonly exito: true; readonly lotes: readonly LotePropuesto[] }
  | { readonly exito: false };

/**
 * Intenta ubicar una secuencia de heats consecutivos (con las cantidades de
 * `valoresPersonas`, en ese orden) mas su limpieza, comenzando exactamente en
 * `inicioMin`. Reutiliza heats existentes con capacidad libre (8.4) y permite
 * que la limpieza terminal de un lote existente se convierta en un heat
 * nuevo, reubicando la limpieza (8.3 ultimo parrafo, DISP-015, ejemplo 9.9).
 */
function intentarColocarLote(
  mapaBloques: Map<number, BloqueDeCalendario>,
  inicioMin: number,
  valoresPersonas: readonly number[],
): ResultadoColocacion {
  const heatsPropuestos: HeatPropuesto[] = [];
  let loteEnExtension: IdLote | null = null;

  for (let i = 0; i < valoresPersonas.length; i++) {
    const personasEnEsteSlot = valoresPersonas[i]!;
    const minutoSlot = inicioMin + i * DURACION_BLOQUE_MINUTOS;
    const bloque = mapaBloques.get(minutoSlot);
    if (!bloque) {
      return { exito: false, motivo: "CRUCE_CON_BLOQUE_NO_DISPONIBLE" };
    }

    if (bloque.tipo === "disponible") {
      heatsPropuestos.push({
        heatId: null,
        horaInicio: bloque.horaInicio,
        horaFin: bloque.horaFin,
        personasAsignadas: personasEnEsteSlot,
        esHeatReutilizado: false,
        capacidadDisponibleAntes: CAPACIDAD_MAXIMA_POR_HEAT,
      });
      continue;
    }

    if (bloque.tipo === "heat") {
      const capacidadLibre = CAPACIDAD_MAXIMA_POR_HEAT - bloque.capacidadOcupada;
      if (capacidadLibre < personasEnEsteSlot) {
        return { exito: false, motivo: "SIN_HEATS_CONSECUTIVOS_DISPONIBLES" };
      }
      if (loteEnExtension === null) {
        loteEnExtension = bloque.loteId;
      } else if (loteEnExtension !== bloque.loteId) {
        return { exito: false, motivo: "CRUCE_CON_BLOQUE_NO_DISPONIBLE" };
      }
      heatsPropuestos.push({
        heatId: bloque.heatId,
        horaInicio: bloque.horaInicio,
        horaFin: bloque.horaFin,
        personasAsignadas: personasEnEsteSlot,
        esHeatReutilizado: true,
        capacidadDisponibleAntes: capacidadLibre,
      });
      continue;
    }

    if (
      bloque.tipo === "limpieza" &&
      i > 0 &&
      loteEnExtension !== null &&
      bloque.loteId === loteEnExtension
    ) {
      // Limpieza terminal del lote que se esta ampliando: pasa a ser un heat
      // nuevo; su limpieza se recalcula mas abajo.
      heatsPropuestos.push({
        heatId: null,
        horaInicio: bloque.horaInicio,
        horaFin: bloque.horaFin,
        personasAsignadas: personasEnEsteSlot,
        esHeatReutilizado: false,
        capacidadDisponibleAntes: CAPACIDAD_MAXIMA_POR_HEAT,
      });
      continue;
    }

    // Almuerzo, bloqueado, cerrado, u otra limpieza: no se puede usar (6.3, 6.4).
    return { exito: false, motivo: "CRUCE_CON_BLOQUE_NO_DISPONIBLE" };
  }

  const minutoLimpieza = inicioMin + valoresPersonas.length * DURACION_BLOQUE_MINUTOS;
  const bloqueLimpieza = mapaBloques.get(minutoLimpieza);
  if (!bloqueLimpieza) {
    return { exito: false, motivo: "CRUCE_CON_BLOQUE_NO_DISPONIBLE" };
  }

  const limpiezaValida =
    bloqueLimpieza.tipo === "disponible" ||
    (bloqueLimpieza.tipo === "limpieza" &&
      loteEnExtension !== null &&
      bloqueLimpieza.loteId === loteEnExtension);

  if (!limpiezaValida) {
    return { exito: false, motivo: "CRUCE_CON_BLOQUE_NO_DISPONIBLE" };
  }

  // El bucle siempre agrega exactamente un HeatPropuesto por cada elemento de
  // valoresPersonas (longitud >= 1 garantizada por el llamador), o retorna
  // antes: heatsPropuestos nunca esta vacio en este punto.
  const primerHeat = heatsPropuestos[0]!;
  const ultimoHeat = heatsPropuestos[heatsPropuestos.length - 1]!;

  const lote: LotePropuesto = {
    loteId: loteEnExtension,
    esLoteReutilizado: loteEnExtension !== null,
    heats: heatsPropuestos,
    horaInicio: primerHeat.horaInicio,
    horaFinActividadCliente: ultimoHeat.horaFin,
    horaFinLimpieza: bloqueLimpieza.horaFin,
  };

  return { exito: true, lote };
}

/** Prueba las permutaciones unicas del vector en una posicion FIJA (sin buscar hacia adelante). */
function buscarEnPosicionFija(
  mapaBloques: Map<number, BloqueDeCalendario>,
  inicioMin: number,
  valores: readonly number[],
): ResultadoColocacion {
  let motivoFallo: MotivoNoDisponible = "SIN_HEATS_CONSECUTIVOS_DISPONIBLES";
  for (const permutacion of permutacionesUnicas(valores)) {
    const resultado = intentarColocarLote(mapaBloques, inicioMin, permutacion);
    if (resultado.exito) return resultado;
    if (resultado.motivo === "CRUCE_CON_BLOQUE_NO_DISPONIBLE") {
      motivoFallo = "CRUCE_CON_BLOQUE_NO_DISPONIBLE";
    }
  }
  return { exito: false, motivo: motivoFallo };
}

/** Busca hacia adelante, de 15 en 15 minutos, el primer inicio donde el lote cabe (6.6). */
function buscarSiguienteLote(
  mapaBloques: Map<number, BloqueDeCalendario>,
  minutoMinimo: number,
  minutoMaximo: number,
  valores: readonly number[],
): ResultadoColocacion {
  for (let inicio = minutoMinimo; inicio <= minutoMaximo; inicio += DURACION_BLOQUE_MINUTOS) {
    const resultado = buscarEnPosicionFija(mapaBloques, inicio, valores);
    if (resultado.exito) return resultado;
  }
  return { exito: false, motivo: "CRUCE_CON_BLOQUE_NO_DISPONIBLE" };
}

/**
 * Ubica cada lote de una particion en orden: el primero exactamente en
 * `inicioMin` (la hora candidata), los siguientes en el primer inicio
 * disponible a partir del fin de la limpieza del lote anterior (6.6).
 */
function buscarLotesEnOrden(
  mapaBloques: Map<number, BloqueDeCalendario>,
  minutoMaximo: number,
  inicioMin: number,
  chunks: readonly (readonly number[])[],
): ResultadoLotesEnOrden {
  const lotes: LotePropuesto[] = [];

  const primerChunk = chunks[0]!;
  const primerResultado = buscarEnPosicionFija(mapaBloques, inicioMin, primerChunk);
  if (!primerResultado.exito) return { exito: false };
  lotes.push(primerResultado.lote);

  for (let i = 1; i < chunks.length; i++) {
    const chunk = chunks[i]!;
    const loteAnterior = lotes[i - 1]!;
    const minutoMinimo = horaAMinutos(loteAnterior.horaFinLimpieza);
    const resultado = buscarSiguienteLote(mapaBloques, minutoMinimo, minutoMaximo, chunk);
    if (!resultado.exito) return { exito: false };
    lotes.push(resultado.lote);
  }

  return { exito: true, lotes };
}

/** Suma de esperas entre el fin de limpieza de un lote y el inicio del siguiente. */
function calcularEsperaTotalMinutos(lotes: readonly LotePropuesto[]): number {
  let total = 0;
  for (let i = 1; i < lotes.length; i++) {
    total += horaAMinutos(lotes[i]!.horaInicio) - horaAMinutos(lotes[i - 1]!.horaFinLimpieza);
  }
  return total;
}

function contarHeatsReutilizados(lotes: readonly LotePropuesto[]): number {
  return lotes.reduce(
    (acumulado, lote) => acumulado + lote.heats.filter((h) => h.esHeatReutilizado).length,
    0,
  );
}

/**
 * Orden de 8.6 dentro de un mismo cantidadLotes (ya garantizado por el
 * llamador): 1) menor hora de finalizacion, 2) menor espera total entre
 * lotes, 3) mejor aprovechamiento de heats existentes.
 */
function compararPlanesLote(
  a: readonly LotePropuesto[],
  b: readonly LotePropuesto[],
): number {
  const finA = horaAMinutos(a[a.length - 1]!.horaFinLimpieza);
  const finB = horaAMinutos(b[b.length - 1]!.horaFinLimpieza);
  if (finA !== finB) return finA - finB;

  const esperaA = calcularEsperaTotalMinutos(a);
  const esperaB = calcularEsperaTotalMinutos(b);
  if (esperaA !== esperaB) return esperaA - esperaB;

  return contarHeatsReutilizados(b) - contarHeatsReutilizados(a);
}

function redondearMoneda(valor: number): number {
  return Math.round(valor * 100) / 100;
}

export function calcularPrecio(tarifa: TarifaServicio, personas: number): PrecioPropuesto {
  const precioPorPersona =
    personas >= UMBRAL_GRUPO_GRANDE ? tarifa.precioPorPersonaGrupoGrande : tarifa.precioPorPersonaGrupoPequeno;
  const montoTotal = redondearMoneda(precioPorPersona * personas);
  const montoDeposito = redondearMoneda((montoTotal * tarifa.porcentajeDeposito) / 100);
  const montoSaldo = redondearMoneda(montoTotal - montoDeposito);
  return { moneda: tarifa.moneda, montoTotal, montoDeposito, montoSaldo };
}

/** Ensambla el `PlanDisponible` final a partir de los lotes ya resueltos.
 *
 * `distribucion` se deriva SIEMPRE de los heats realmente colocados (nunca
 * del vector equilibrado pre-permutacion que calculo `construirPlan`):
 * cuando el motor prueba una permutacion distinta de la identidad para que
 * el plan quepa (7.2, DISP-015), los heats quedan en ese orden permutado, y
 * `distribucion` debe reflejar exactamente ese orden para que un llamador
 * pueda hacer zip(distribucion, heats) por indice con seguridad. */
function construirPlanDisponible(
  lotes: readonly LotePropuesto[],
  cantidadPersonas: number,
  contexto: ContextoDisponibilidad,
): PlanDisponible {
  const ultimoLote = lotes[lotes.length - 1]!;

  const distribucion: VectorDistribucion = lotes.flatMap((lote) =>
    lote.heats.map((heat) => heat.personasAsignadas),
  );

  const capacidadesRetenidas: RetencionDeCapacidad[] = lotes.flatMap((lote) =>
    lote.heats.map((heat) => ({
      heatId: heat.heatId,
      loteId: lote.loteId,
      personas: heat.personasAsignadas,
    })),
  );

  const precio = contexto.tarifa ? calcularPrecio(contexto.tarifa, cantidadPersonas) : undefined;

  return {
    disponible: true,
    cantidadLotes: lotes.length,
    distribucion,
    lotes,
    horaFinActividadCliente: ultimoLote.horaFinActividadCliente,
    liberacionOperativa: ultimoLote.horaFinLimpieza,
    capacidadesRetenidas,
    ...(precio !== undefined ? { precio } : {}),
  };
}

// ----------------------------------------------------------------------------
// 11. Normalizacion de lotes tras liberacion (6.7.6-8, 11.2, 19.1)
// ----------------------------------------------------------------------------
// Al vencer una reserva temporal (o rechazarse un SINPE), sus asignaciones se
// liberan. Esta funcion pura decide que le pasa al LOTE que contenia esos
// heats, sin tocar la base de datos: el servicio de expiracion es quien la
// invoca dentro de una transaccion y aplica el resultado (16.6, 19.1).

/** Heat de un lote, tal como esta la INSTANTE de liberar las asignaciones
 * (ya reflejando cuales quedaron sin ningun participante activo). */
export interface HeatParaNormalizar {
  readonly heatId: IdHeat;
  /** Orden original dentro del lote, 1-based (debe venir ya ordenado ascendente). */
  readonly posicionEnLote: number;
  readonly horaInicio: HoraISO;
  readonly horaFin: HoraISO;
  /** true si, tras liberar las asignaciones que vencieron, no le queda
   * ningun participante activo (ni confirmado ni retenido). */
  readonly quedaVacio: boolean;
}

export interface LoteParaNormalizar {
  readonly loteId: IdLote;
  /** Heats del lote, ordenados por `posicionEnLote` ascendente (6.1.12). */
  readonly heats: readonly HeatParaNormalizar[];
}

/** El lote no tiene ningun heat con participantes: se elimina por completo,
 * heats y limpieza incluidos (6.7.7). */
export interface NormalizacionEliminarLote {
  readonly accion: "eliminar_lote";
}

/** Ningun heat vacio esta al inicio o al final: el lote no cambia de forma.
 * Un heat vacio "en medio" de dos ocupados permanece como parte del lote y
 * puede recibir nuevas reservas (6.7.8, ultima oracion). */
export interface NormalizacionSinCambios {
  readonly accion: "sin_cambios";
}

/** Se retiran los heats vacios del inicio y/o del final; los heats que
 * quedan se renumeran desde 1 y la limpieza se reposiciona justo despues
 * del nuevo ultimo heat (6.7.8). */
export interface NormalizacionRecortarLote {
  readonly accion: "recortar_lote";
  readonly heatIdsAEliminar: readonly IdHeat[];
  /** Heats que permanecen, con su nueva posicion 1-based dentro del lote recortado. */
  readonly heatsConservados: readonly { readonly heatId: IdHeat; readonly nuevaPosicionEnLote: number }[];
  readonly horaInicio: HoraISO;
  readonly horaFinUltimoHeat: HoraISO;
  readonly horaInicioLimpieza: HoraISO;
  readonly horaFinLimpieza: HoraISO;
  readonly cantidadHeats: number;
}

export type ResultadoNormalizacionLote =
  | NormalizacionEliminarLote
  | NormalizacionSinCambios
  | NormalizacionRecortarLote;

/**
 * Decide que le pasa a un lote despues de liberar algunas de sus
 * asignaciones (6.7.6-8):
 *   - Si TODOS sus heats quedan vacios, el lote se elimina completo (6.7.7).
 *   - Si ninguno de los heats vacios esta en el extremo inicial ni en el
 *     final, el lote no cambia de forma (un heat vacio "en medio" se
 *     conserva, 6.7.8).
 *   - En otro caso, se recortan los heats vacios de cada extremo y se
 *     reposiciona la limpieza justo despues del nuevo ultimo heat.
 *
 * No toca base de datos ni recibe nada mas que el estado ya calculado de
 * "quedaVacio" por heat; el servicio de expiracion es quien arma ese estado
 * a partir de las asignaciones activas restantes y aplica el resultado.
 */
export function normalizarLoteTrasLiberacion(
  lote: LoteParaNormalizar,
): ResultadoNormalizacionLote {
  const heats = lote.heats;

  if (heats.length === 0 || heats.every((h) => h.quedaVacio)) {
    return { accion: "eliminar_lote" };
  }

  const primerOcupado = heats.findIndex((h) => !h.quedaVacio);
  let ultimoOcupado = -1;
  for (let i = heats.length - 1; i >= 0; i--) {
    if (!heats[i]!.quedaVacio) {
      ultimoOcupado = i;
      break;
    }
  }

  if (primerOcupado === 0 && ultimoOcupado === heats.length - 1) {
    return { accion: "sin_cambios" };
  }

  const conservados = heats.slice(primerOcupado, ultimoOcupado + 1);
  const eliminados = [...heats.slice(0, primerOcupado), ...heats.slice(ultimoOcupado + 1)];
  const primerConservado = conservados[0]!;
  const ultimoConservado = conservados[conservados.length - 1]!;
  const horaFinUltimoHeat = ultimoConservado.horaFin;

  return {
    accion: "recortar_lote",
    heatIdsAEliminar: eliminados.map((h) => h.heatId),
    heatsConservados: conservados.map((h, i) => ({
      heatId: h.heatId,
      nuevaPosicionEnLote: i + 1,
    })),
    horaInicio: primerConservado.horaInicio,
    horaFinUltimoHeat,
    horaInicioLimpieza: horaFinUltimoHeat,
    horaFinLimpieza: minutosAHora(horaAMinutos(horaFinUltimoHeat) + DURACION_BLOQUE_MINUTOS),
    cantidadHeats: conservados.length,
  };
}
