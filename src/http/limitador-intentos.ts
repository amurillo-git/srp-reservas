// ============================================================================
// Limitador de intentos en memoria, por clave (normalmente la IP del cliente):
// permite `max` intentos por ventana de tiempo fija. Protege las consultas
// publicas que se podrian recorrer en serie (ej. buscar una reserva por
// telefono y fecha). El estado vive en el proceso: si el servidor se reinicia,
// los contadores empiezan de cero, lo cual es aceptable para este uso.
// ============================================================================

export interface ResultadoLimite {
  readonly permitido: boolean;
  /** Segundos que faltan para que la ventana actual termine. */
  readonly reintentarEnSeg: number;
}

export interface OpcionesLimitador {
  readonly max: number;
  readonly ventanaMs: number;
  /** Reloj inyectable para pruebas. */
  readonly ahora?: () => number;
}

/** Cuando el mapa supera este tamano se descartan las ventanas ya vencidas. */
const TAMANO_PARA_LIMPIAR = 1_000;

export function crearLimitadorIntentos({
  max,
  ventanaMs,
  ahora = Date.now,
}: OpcionesLimitador): (clave: string) => ResultadoLimite {
  const ventanas = new Map<string, { inicio: number; intentos: number }>();

  return (clave) => {
    const t = ahora();

    if (ventanas.size > TAMANO_PARA_LIMPIAR) {
      for (const [k, v] of ventanas) {
        if (t - v.inicio >= ventanaMs) ventanas.delete(k);
      }
    }

    let ventana = ventanas.get(clave);
    if (!ventana || t - ventana.inicio >= ventanaMs) {
      ventana = { inicio: t, intentos: 0 };
      ventanas.set(clave, ventana);
    }
    ventana.intentos += 1;

    return {
      permitido: ventana.intentos <= max,
      reintentarEnSeg: Math.ceil((ventana.inicio + ventanaMs - t) / 1000),
    };
  };
}
