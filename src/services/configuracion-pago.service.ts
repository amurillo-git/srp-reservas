// ============================================================================
// Configuracion global de pagos (25): un unico registro que decide si el
// deposito/saldo por SINPE se confirma manualmente (revision de comprobante
// por un admin) o automaticamente via ONVO (webhook de payment-intent).
// Nunca los dos modos a la vez.
// ============================================================================

import { PrismaClient } from "@prisma/client";

export type ModoSinpe = "MANUAL" | "ONVO";

const ID_SINGLETON = "singleton";

/** Devuelve MANUAL si todavia no existe el registro (comportamiento actual
 * antes de que un admin elija explicitamente). */
export async function obtenerModoSinpe(prisma: PrismaClient): Promise<ModoSinpe> {
  const config = await prisma.configuracionPago.findUnique({ where: { id: ID_SINGLETON } });
  return config?.modoSinpe ?? "MANUAL";
}

export async function establecerModoSinpe(prisma: PrismaClient, modo: ModoSinpe): Promise<void> {
  await prisma.configuracionPago.upsert({
    where: { id: ID_SINGLETON },
    create: { id: ID_SINGLETON, modoSinpe: modo },
    update: { modoSinpe: modo },
  });
}
