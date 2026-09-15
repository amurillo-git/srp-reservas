"use client";

import { useState, type FormEvent } from "react";
import { User } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { DatosClienteReserva } from "@/lib/types";

export function CustomerStep({
  valorInicial,
  onSubmit,
}: {
  valorInicial: DatosClienteReserva | null;
  onSubmit: (cliente: DatosClienteReserva) => void;
}) {
  const [nombre, setNombre] = useState(valorInicial?.name ?? "");
  const [telefono, setTelefono] = useState(valorInicial?.phone ?? "");
  const [email, setEmail] = useState(valorInicial?.email ?? "");

  function manejarEnvio(evento: FormEvent) {
    evento.preventDefault();
    if (nombre.trim().length === 0 || telefono.trim().length === 0) return;
    onSubmit({ name: nombre.trim(), phone: telefono.trim(), email: email.trim() || undefined });
  }

  return (
    <Card className="border-none shadow-sm">
      <CardHeader>
        <div className="flex size-11 items-center justify-center rounded-2xl bg-primary/10 text-primary">
          <User className="size-5" />
        </div>
        <CardTitle className="text-xl">Tus datos</CardTitle>
        <CardDescription>Los usaremos para confirmar tu reserva.</CardDescription>
      </CardHeader>
      <CardContent>
        <form className="flex flex-col gap-4" onSubmit={manejarEnvio}>
          <div className="flex flex-col gap-2">
            <Label htmlFor="nombre">Nombre completo</Label>
            <Input id="nombre" value={nombre} onChange={(e) => setNombre(e.target.value)} required className="rounded-xl" />
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="telefono">Teléfono</Label>
            <Input id="telefono" value={telefono} onChange={(e) => setTelefono(e.target.value)} required className="rounded-xl" />
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="email">Correo (opcional)</Label>
            <Input id="email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} className="rounded-xl" />
          </div>
          <Button type="submit" size="lg" className="mt-2 rounded-2xl">
            Continuar
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}
