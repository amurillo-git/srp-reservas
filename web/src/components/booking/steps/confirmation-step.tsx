"use client";

import Link from "next/link";
import { PartyPopper } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";

export function ConfirmationStep({ codigoPublico }: { codigoPublico: string }) {
  return (
    <Card className="border-none shadow-sm">
      <CardHeader>
        <div className="flex size-11 items-center justify-center rounded-2xl bg-primary/10 text-primary">
          <PartyPopper className="size-5" />
        </div>
        <CardTitle className="text-xl">¡Listo! Tu comprobante quedó registrado</CardTitle>
        <CardDescription>
          Una persona de Sarapiquí Race Park va a validar tu pago pronto. Guardá tu código de reserva.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col items-center gap-6">
        <div className="w-full rounded-2xl bg-accent p-6 text-center">
          <p className="text-muted-foreground text-sm">Código de reserva</p>
          <p className="mt-1 text-3xl font-bold tracking-wide">{codigoPublico}</p>
        </div>
        <Button
          render={<Link href={`/mi-reserva?codigo=${codigoPublico}`} />}
          nativeButton={false}
          size="lg"
          className="w-full rounded-2xl"
        >
          Ver el estado de mi reserva
        </Button>
      </CardContent>
    </Card>
  );
}
