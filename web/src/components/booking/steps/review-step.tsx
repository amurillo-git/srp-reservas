"use client";

import { useEffect, useState } from "react";
import { CheckCircle2, ClipboardList } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import { formatoFechaLarga, formatoMoneda } from "@/lib/format";
import { consultarCotizacion, crearReserva } from "@/lib/api";
import type { EstadoWizard } from "../types";
import type { PlanDisponibilidad } from "@/lib/types";

export function ReviewStep({
  estado,
  onConfirmado,
  onSinDisponibilidad,
  onBack,
}: {
  estado: EstadoWizard;
  onConfirmado: (codigoPublico: string, plan: PlanDisponibilidad) => void;
  onSinDisponibilidad: () => void;
  onBack: () => void;
}) {
  const { servicio, fecha, horaInicio, cantidadPersonas, cliente } = estado;
  const [cotizacion, setCotizacion] = useState<PlanDisponibilidad | null>(null);
  const [enviando, setEnviando] = useState(false);

  useEffect(() => {
    if (!fecha || !horaInicio || !cantidadPersonas) return;
    let cancelado = false;
    consultarCotizacion(servicio.id, fecha, horaInicio, cantidadPersonas)
      .then((plan) => !cancelado && setCotizacion(plan))
      .catch(() => !cancelado && toast.error("No pudimos calcular el precio. Intentá de nuevo."));
    return () => {
      cancelado = true;
    };
  }, [servicio.id, fecha, horaInicio, cantidadPersonas]);

  async function confirmar() {
    if (!fecha || !horaInicio || !cantidadPersonas || !cliente) return;
    setEnviando(true);
    try {
      const resultado = await crearReserva(
        { serviceId: servicio.id, date: fecha, startTime: horaInicio, partySize: cantidadPersonas, customer: cliente },
        estado.idempotencyKey,
      );
      if (resultado.exito) {
        onConfirmado(resultado.codigoPublico, resultado.plan);
        return;
      }
      if (resultado.motivo === "NO_DISPONIBLE") {
        toast.error("Ese horario ya no tiene cupo. Elegí otra hora.");
        onSinDisponibilidad();
        return;
      }
      toast.error("Hubo mucha demanda para ese horario. Intentá de nuevo.");
    } catch {
      toast.error("No pudimos completar la reserva. Intentá de nuevo.");
    } finally {
      setEnviando(false);
    }
  }

  if (!fecha || !horaInicio || !cantidadPersonas || !cliente) return null;

  return (
    <Card className="border-none shadow-sm">
      <CardHeader>
        <div className="flex size-11 items-center justify-center rounded-2xl bg-primary/10 text-primary">
          <ClipboardList className="size-5" />
        </div>
        <CardTitle className="text-xl">Revisá tu reserva</CardTitle>
        <CardDescription>Confirmá los datos antes de continuar.</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <dl className="grid grid-cols-2 gap-y-3 text-sm">
          <dt className="text-muted-foreground">Fecha</dt>
          <dd className="text-right font-medium">{formatoFechaLarga(fecha)}</dd>
          <dt className="text-muted-foreground">Hora</dt>
          <dd className="text-right font-medium">{horaInicio}</dd>
          <dt className="text-muted-foreground">Personas</dt>
          <dd className="text-right font-medium">{cantidadPersonas}</dd>
          <dt className="text-muted-foreground">Nombre</dt>
          <dd className="text-right font-medium">{cliente.name}</dd>
          <dt className="text-muted-foreground">Teléfono</dt>
          <dd className="text-right font-medium">{cliente.phone}</dd>
        </dl>

        <Separator />

        {cotizacion === null ? (
          <Skeleton className="h-20 rounded-xl" />
        ) : cotizacion.disponible && cotizacion.precio ? (
          <div className="rounded-2xl bg-accent p-4">
            <div className="flex items-center justify-between text-sm">
              <span>Total</span>
              <span className="font-medium">{formatoMoneda(cotizacion.precio.montoTotal, cotizacion.precio.moneda)}</span>
            </div>
            <div className="mt-1 flex items-center justify-between text-sm">
              <span>Depósito a pagar ahora</span>
              <span className="font-semibold text-primary">
                {formatoMoneda(cotizacion.precio.montoDeposito, cotizacion.precio.moneda)}
              </span>
            </div>
          </div>
        ) : null}

        <div className="flex gap-3">
          <Button type="button" variant="ghost" className="rounded-2xl" onClick={onBack} disabled={enviando}>
            Atrás
          </Button>
          <Button type="button" size="lg" className="flex-1 rounded-2xl" onClick={confirmar} disabled={enviando}>
            <CheckCircle2 className="size-4" />
            {enviando ? "Confirmando..." : "Confirmar y reservar"}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
