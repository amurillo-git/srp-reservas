"use client";

import { useEffect, useState, type FormEvent } from "react";
import { useSearchParams } from "next/navigation";
import { Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { formatoFechaLarga, formatoMoneda } from "@/lib/format";
import { consultarReserva } from "@/lib/api";
import type { ReservaPublica } from "@/lib/types";
import { PaymentStep } from "./steps/payment-step";

const ETIQUETA_ESTADO: Record<string, string> = {
  TEMPORAL: "Retenida, pendiente de pago",
  PENDIENTE_VALIDACION_SINPE: "Comprobante en revisión",
  CONFIRMADA: "Confirmada",
  RECHAZADA: "Comprobante rechazado",
  CANCELADA: "Cancelada",
  EXPIRADA: "Vencida",
};

/** Segundos hasta que venza la retención (14.8): puede dar 0 si ya venció
 * pero el worker de expiracion (corre cada minuto) todavia no lo reflejo en
 * el estado. */
function segundosHastaExpirar(expiraEn: string): number {
  return Math.max(0, Math.floor((new Date(expiraEn).getTime() - Date.now()) / 1000));
}

export function ReservationLookup() {
  const searchParams = useSearchParams();
  const [codigo, setCodigo] = useState(searchParams.get("codigo") ?? "");
  const [reserva, setReserva] = useState<ReservaPublica | null | undefined>(undefined);
  const [buscando, setBuscando] = useState(false);

  async function buscar(codigoBuscado: string) {
    if (codigoBuscado.trim().length === 0) return;
    setBuscando(true);
    try {
      setReserva(await consultarReserva(codigoBuscado.trim()));
    } finally {
      setBuscando(false);
    }
  }

  useEffect(() => {
    const codigoInicial = searchParams.get("codigo");
    if (!codigoInicial) return;
    let cancelado = false;
    consultarReserva(codigoInicial.trim()).then((r) => !cancelado && setReserva(r));
    return () => {
      cancelado = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function manejarEnvio(evento: FormEvent) {
    evento.preventDefault();
    buscar(codigo);
  }

  const puedeReanudarPago =
    reserva?.estado === "TEMPORAL" && reserva.expiraEn !== null && segundosHastaExpirar(reserva.expiraEn) > 0;

  return (
    <div className="flex w-full max-w-lg flex-col gap-6">
      <Card className="border-none shadow-sm">
        <CardHeader>
          <div className="flex size-11 items-center justify-center rounded-2xl bg-primary/10 text-primary">
            <Search className="size-5" />
          </div>
          <CardTitle className="text-xl">Consultá tu reserva</CardTitle>
          <CardDescription>Ingresá el código que recibiste al reservar.</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-6">
          <form className="flex gap-3" onSubmit={manejarEnvio}>
            <div className="flex-1">
              <Label htmlFor="codigo" className="sr-only">
                Código de reserva
              </Label>
              <Input
                id="codigo"
                value={codigo}
                onChange={(e) => setCodigo(e.target.value)}
                placeholder="SRP-XXXXX"
                className="rounded-xl"
              />
            </div>
            <Button type="submit" className="rounded-xl" disabled={buscando}>
              {buscando ? "Buscando..." : "Buscar"}
            </Button>
          </form>

          {reserva === null && (
            <p className="text-muted-foreground text-sm">No encontramos ninguna reserva con ese código.</p>
          )}

          {reserva && (
            <div className="flex flex-col gap-4">
              <div className="flex items-center justify-between">
                <span className="font-semibold">{reserva.codigoPublico}</span>
                <Badge variant="secondary" className="rounded-full">
                  {ETIQUETA_ESTADO[reserva.estado] ?? reserva.estado}
                </Badge>
              </div>
              <Separator />
              <dl className="grid grid-cols-2 gap-y-3 text-sm">
                <dt className="text-muted-foreground">Fecha</dt>
                <dd className="text-right font-medium">{formatoFechaLarga(reserva.fecha)}</dd>
                <dt className="text-muted-foreground">Personas</dt>
                <dd className="text-right font-medium">{reserva.cantidadPersonas}</dd>
                <dt className="text-muted-foreground">Total</dt>
                <dd className="text-right font-medium">{formatoMoneda(reserva.montoTotal, reserva.moneda)}</dd>
                <dt className="text-muted-foreground">Depósito</dt>
                <dd className="text-right font-medium">{formatoMoneda(reserva.montoDeposito, reserva.moneda)}</dd>
                <dt className="text-muted-foreground">Saldo pendiente</dt>
                <dd className="text-right font-medium">{formatoMoneda(reserva.montoSaldo, reserva.moneda)}</dd>
              </dl>
              {reserva.lotes.length > 0 && (
                <div className="rounded-2xl bg-accent p-4 text-sm">
                  {reserva.lotes.map((lote, i) => (
                    <div key={i} className="flex flex-wrap gap-2">
                      {lote.heats.map((heat, j) => (
                        <span key={j} className="rounded-lg bg-background px-2 py-1">
                          {heat.horaInicio}–{heat.horaFin} · {heat.personas}p
                        </span>
                      ))}
                    </div>
                  ))}
                </div>
              )}
              {reserva.estado === "TEMPORAL" && !puedeReanudarPago && (
                <p className="text-sm text-destructive">
                  El tiempo para completar el pago venció. Hacé una nueva reserva para volver a intentarlo.
                </p>
              )}
            </div>
          )}
        </CardContent>
      </Card>

      {reserva && puedeReanudarPago && reserva.expiraEn && (
        <PaymentStep
          codigoPublico={reserva.codigoPublico}
          deposito={{ montoDeposito: reserva.montoDeposito, moneda: reserva.moneda }}
          pagoTarjetaHabilitado={reserva.pagoTarjetaHabilitado}
          segundosRestantesIniciales={segundosHastaExpirar(reserva.expiraEn)}
          onReportado={() => buscar(reserva.codigoPublico)}
        />
      )}
    </div>
  );
}
