"use client";

import { useEffect, useState } from "react";
import { Clock } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { formatoFechaLarga } from "@/lib/format";
import { listarHorasDisponibles } from "@/lib/api";

export function TimeStep({
  servicioId,
  fecha,
  cantidadPersonas,
  onSelect,
  onBack,
}: {
  servicioId: string;
  fecha: string;
  cantidadPersonas: number;
  onSelect: (hora: string) => void;
  onBack: () => void;
}) {
  const [resultado, setResultado] = useState<{ clave: string; horas: readonly string[] } | null>(null);
  const clave = `${servicioId}|${fecha}|${cantidadPersonas}`;

  useEffect(() => {
    let cancelado = false;
    listarHorasDisponibles(servicioId, fecha, cantidadPersonas)
      .then((h) => !cancelado && setResultado({ clave, horas: h }))
      .catch(() => {
        if (!cancelado) {
          toast.error("No pudimos cargar los horarios. Intentá de nuevo.");
          setResultado({ clave, horas: [] });
        }
      });
    return () => {
      cancelado = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clave]);

  const horas = resultado?.clave === clave ? resultado.horas : null;

  return (
    <Card className="border-none shadow-sm">
      <CardHeader>
        <div className="flex size-11 items-center justify-center rounded-2xl bg-primary/10 text-primary">
          <Clock className="size-5" />
        </div>
        <CardTitle className="text-xl">Elegí una hora</CardTitle>
        <CardDescription>{formatoFechaLarga(fecha)}</CardDescription>
      </CardHeader>
      <CardContent>
        {horas === null ? (
          <div className="grid grid-cols-3 gap-3 sm:grid-cols-4">
            {Array.from({ length: 8 }).map((_, i) => (
              <Skeleton key={i} className="h-11 rounded-xl" />
            ))}
          </div>
        ) : horas.length === 0 ? (
          <p className="text-muted-foreground text-sm">No hay horarios disponibles ese día para este grupo.</p>
        ) : (
          <div className="grid grid-cols-3 gap-3 sm:grid-cols-4">
            {horas.map((hora) => (
              <Button
                key={hora}
                type="button"
                variant="secondary"
                className="rounded-xl"
                onClick={() => onSelect(hora)}
              >
                {hora}
              </Button>
            ))}
          </div>
        )}
        <Button type="button" variant="ghost" className="mt-4 w-fit rounded-2xl" onClick={onBack}>
          Atrás
        </Button>
      </CardContent>
    </Card>
  );
}
