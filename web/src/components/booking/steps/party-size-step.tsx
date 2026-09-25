"use client";

import { useState } from "react";
import { Minus, Plus, Users } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";

const MIN = 1;
const MAX = 40;

export function PartySizeStep({
  valorInicial,
  valorInicialRepeticiones,
  onSubmit,
}: {
  valorInicial: number | null;
  valorInicialRepeticiones: number;
  onSubmit: (cantidad: number, repeticiones: number) => void;
}) {
  const [cantidad, setCantidad] = useState(valorInicial ?? 5);
  const [repeticiones, setRepeticiones] = useState(valorInicialRepeticiones);

  function ajustar(delta: number) {
    setCantidad((c) => Math.min(MAX, Math.max(MIN, c + delta)));
  }

  return (
    <Card className="border-none shadow-sm">
      <CardHeader>
        <div className="flex size-11 items-center justify-center rounded-2xl bg-primary/10 text-primary">
          <Users className="size-5" />
        </div>
        <CardTitle className="text-xl">¿Cuántas personas van a correr?</CardTitle>
        <CardDescription>Incluí a todos los participantes de la experiencia.</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-6">
        <div className="flex items-center justify-center gap-6">
          <Button
            type="button"
            variant="secondary"
            size="icon"
            className="size-12 rounded-2xl"
            onClick={() => ajustar(-1)}
            disabled={cantidad <= MIN}
            aria-label="Restar persona"
          >
            <Minus className="size-5" />
          </Button>
          <span className="w-16 text-center text-4xl font-semibold tabular-nums">{cantidad}</span>
          <Button
            type="button"
            variant="secondary"
            size="icon"
            className="size-12 rounded-2xl"
            onClick={() => ajustar(1)}
            disabled={cantidad >= MAX}
            aria-label="Sumar persona"
          >
            <Plus className="size-5" />
          </Button>
        </div>

        <div className="flex flex-col items-center gap-2">
          <span className="text-muted-foreground text-sm">¿Cuántas vueltas completas?</span>
          <div className="flex items-center justify-center gap-3">
            <Button
              type="button"
              variant={repeticiones === 1 ? "default" : "secondary"}
              className="rounded-2xl"
              onClick={() => setRepeticiones(1)}
            >
              1 Heat (15 minutos)
            </Button>
            <Button
              type="button"
              variant={repeticiones === 2 ? "default" : "secondary"}
              className="rounded-2xl"
              onClick={() => setRepeticiones(2)}
            >
              2 Heats (30 minutos)
            </Button>
          </div>
        </div>

        <Button size="lg" className="rounded-2xl" onClick={() => onSubmit(cantidad, repeticiones)}>
          Continuar
        </Button>
      </CardContent>
    </Card>
  );
}
