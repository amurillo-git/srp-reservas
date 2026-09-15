"use client";

import { useState } from "react";
import { Minus, Plus, Users } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";

const MIN = 1;
const MAX = 40;

export function PartySizeStep({
  valorInicial,
  onSubmit,
}: {
  valorInicial: number | null;
  onSubmit: (cantidad: number) => void;
}) {
  const [cantidad, setCantidad] = useState(valorInicial ?? 5);

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
        <Button size="lg" className="rounded-2xl" onClick={() => onSubmit(cantidad)}>
          Continuar
        </Button>
      </CardContent>
    </Card>
  );
}
