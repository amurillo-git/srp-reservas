export function formatoMoneda(monto: number, moneda: string): string {
  return new Intl.NumberFormat("es-CR", { style: "currency", currency: moneda, maximumFractionDigits: 0 }).format(
    monto,
  );
}

/** "YYYY-MM-DD" -> "Domingo, 13 de septiembre de 2026" (solo la primera letra en mayúscula). */
export function formatoFechaLarga(fechaISO: string): string {
  const fecha = new Date(`${fechaISO}T00:00:00.000Z`);
  const texto = new Intl.DateTimeFormat("es-CR", { dateStyle: "full", timeZone: "UTC" }).format(fecha);
  return texto.charAt(0).toUpperCase() + texto.slice(1);
}

/** Fecha de hoy en la hora local del navegador (no UTC), formato "YYYY-MM-DD". */
export function hoyISO(): string {
  const hoy = new Date();
  const anio = hoy.getFullYear();
  const mes = String(hoy.getMonth() + 1).padStart(2, "0");
  const dia = String(hoy.getDate()).padStart(2, "0");
  return `${anio}-${mes}-${dia}`;
}
