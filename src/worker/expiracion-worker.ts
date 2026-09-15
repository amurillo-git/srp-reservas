// ============================================================================
// Dispara expirarReservasVencidas (../services/expiracion.service.ts)
// periodicamente mientras el proceso del servidor esta vivo (19.1). No
// reimplementa la logica de expiracion ni decide que pasa con cada reserva:
// solo la llama a un ritmo fijo, evitando pasadas solapadas y sin tumbar el
// proceso si una pasada falla.
// ============================================================================

export interface WorkerExpiracion {
  readonly detener: () => void;
}

/**
 * Ejecuta `pasada` inmediatamente y luego cada `intervaloMs`. Si una pasada
 * sigue en curso cuando toca la siguiente, ese tick se salta (no se apilan
 * llamadas concurrentes). Un error en `pasada` se reporta via `onError` y no
 * detiene el worker.
 */
export function iniciarWorkerExpiracion(
  pasada: () => Promise<unknown>,
  intervaloMs: number,
  onError: (error: unknown) => void = (error) => console.error("Error en el worker de expiracion:", error),
): WorkerExpiracion {
  let enCurso = false;

  const ejecutarSiLibre = (): void => {
    if (enCurso) return;
    enCurso = true;
    pasada()
      .catch(onError)
      .finally(() => {
        enCurso = false;
      });
  };

  ejecutarSiLibre();
  const intervalId = setInterval(ejecutarSiLibre, intervaloMs);

  return {
    detener: () => clearInterval(intervalId),
  };
}
