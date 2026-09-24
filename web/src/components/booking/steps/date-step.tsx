"use client";

import { useEffect, useState } from "react";
import { CalendarDays } from "lucide-react";
import { es } from "date-fns/locale";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Calendar } from "@/components/ui/calendar";
import { Skeleton } from "@/components/ui/skeleton";
import { listarFechasDisponibles } from "@/lib/api";

function aAnioMes(fecha: Date): string {
  return `${fecha.getFullYear()}-${String(fecha.getMonth() + 1).padStart(2, "0")}`;
}

function aFechaISO(fecha: Date): string {
  return `${fecha.getFullYear()}-${String(fecha.getMonth() + 1).padStart(2, "0")}-${String(fecha.getDate()).padStart(2, "0")}`;
}

const HOY = new Date();
HOY.setHours(0, 0, 0, 0);

interface ResultadoDisponibilidad {
  readonly clave: string;
  readonly fechas: Set<string>;
}

export function DateStep({
  servicioId,
  cantidadPersonas,
  onSelect,
  onBack,
}: {
  servicioId: string;
  cantidadPersonas: number;
  onSelect: (fecha: string) => void;
  onBack: () => void;
}) {
  const [mesMostrado, setMesMostrado] = useState(new Date());
  const [resultado, setResultado] = useState<ResultadoDisponibilidad | null>(null);
  const clave = `${servicioId}|${cantidadPersonas}|${aAnioMes(mesMostrado)}`;

  useEffect(() => {
    let cancelado = false;
    listarFechasDisponibles(servicioId, aAnioMes(mesMostrado), cantidadPersonas)
      .then((fechas) => {
        if (!cancelado) setResultado({ clave, fechas: new Set(fechas) });
      })
      .catch(() => {
        if (!cancelado) {
          toast.error("No pudimos cargar la disponibilidad. Intentá de nuevo.");
          setResultado({ clave, fechas: new Set() });
        }
      });
    return () => {
      cancelado = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clave]);

  const fechasDisponibles = resultado?.clave === clave ? resultado.fechas : null;

  return (
    <Card className="border-none shadow-sm">
      <CardHeader>
        <div className="flex size-11 items-center justify-center rounded-2xl bg-primary/10 text-primary">
          <CalendarDays className="size-5" />
        </div>
        <CardTitle className="text-xl">Elegí una fecha</CardTitle>
        <CardDescription>Solo se muestran fechas con cupo para {cantidadPersonas} personas.</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col items-center">
        {fechasDisponibles === null ? (
          <Skeleton className="h-80 w-full max-w-sm rounded-2xl" />
        ) : (
          <Calendar
            mode="single"
            locale={es}
            month={mesMostrado}
            onMonthChange={setMesMostrado}
            onSelect={(fecha) => fecha && onSelect(aFechaISO(fecha))}
            disabled={(fecha) => fecha < HOY || !fechasDisponibles.has(aFechaISO(fecha))}
            className="rounded-2xl border"
          />
        )}
        <Button type="button" variant="ghost" className="mt-4 w-fit rounded-2xl" onClick={onBack}>
          Atrás
        </Button>
      </CardContent>
    </Card>
  );
}
