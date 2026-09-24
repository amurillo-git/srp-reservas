"use client";

import { useEffect, useState } from "react";
import { Repeat } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { consultarDisponibilidadRepeticiones } from "@/lib/api";

export function SecondRoundStep({
  servicioId,
  fecha,
  horaInicio,
  cantidadPersonas,
  onContinuo,
  onSeparado,
  onSinDisponibilidad,
  onBack,
}: {
  servicioId: string;
  fecha: string;
  horaInicio: string;
  cantidadPersonas: number;
  onContinuo: () => void;
  onSeparado: (horaInicioVuelta2: string) => void;
  onSinDisponibilidad: () => void;
  onBack: () => void;
}) {
  const [horas, setHoras] = useState<readonly string[] | null>(null);

  useEffect(() => {
    let cancelado = false;
    consultarDisponibilidadRepeticiones(servicioId, fecha, horaInicio, cantidadPersonas, 2)
      .then((resultado) => {
        if (cancelado) return;
        if (resultado.tipo === "continuo") {
          onContinuo();
        } else if (resultado.tipo === "requiere_horario_separado") {
          setHoras(resultado.horasDisponiblesVuelta2);
        } else {
          toast.error("Ya no hay cupo para la 2ª vuelta a esa hora. Elegí otro horario.");
          onSinDisponibilidad();
        }
      })
      .catch(() => {
        if (!cancelado) {
          toast.error("No pudimos verificar la 2ª vuelta. Intentá de nuevo.");
          onSinDisponibilidad();
        }
      });
    return () => {
      cancelado = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [servicioId, fecha, horaInicio, cantidadPersonas]);

  return (
    <Card className="border-none shadow-sm">
      <CardHeader>
        <div className="flex size-11 items-center justify-center rounded-2xl bg-primary/10 text-primary">
          <Repeat className="size-5" />
        </div>
        <CardTitle className="text-xl">Elegí la hora de tu 2ª vuelta</CardTitle>
        <CardDescription>
          {horas === null
            ? "Estamos viendo si tu 2ª vuelta puede ser justo después de la primera..."
            : "No cupo justo después de la 1ª vuelta. Elegí otro horario ese mismo día."}
        </CardDescription>
      </CardHeader>
      <CardContent>
        {horas === null ? (
          <div className="grid grid-cols-3 gap-3 sm:grid-cols-4">
            {Array.from({ length: 8 }).map((_, i) => (
              <Skeleton key={i} className="h-11 rounded-xl" />
            ))}
          </div>
        ) : horas.length === 0 ? (
          <p className="text-muted-foreground text-sm">No hay más horarios disponibles ese día para la 2ª vuelta.</p>
        ) : (
          <div className="grid grid-cols-3 gap-3 sm:grid-cols-4">
            {horas.map((hora) => (
              <Button
                key={hora}
                type="button"
                variant="secondary"
                className="rounded-xl"
                onClick={() => onSeparado(hora)}
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
