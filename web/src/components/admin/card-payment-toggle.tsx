"use client";

import { useState } from "react";
import { CreditCard } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { actualizarPagoTarjetaAdmin } from "@/lib/admin-api";

const MOTIVOS: Record<string, string> = {
  WEBHOOK_NO_CONFIGURADO:
    "No se puede activar todavía: falta configurar el webhook de ONVO en el servidor (ONVO_WEBHOOK_SECRET).",
};

function textoMotivo(motivo: string): string {
  return MOTIVOS[motivo] ?? motivo;
}

export function CardPaymentToggle({
  token,
  serviceId,
  initialEnabled,
}: {
  token: string;
  serviceId: string;
  initialEnabled: boolean;
}) {
  const [habilitado, setHabilitado] = useState(initialEnabled);
  const [procesando, setProcesando] = useState(false);

  async function alternar() {
    setProcesando(true);
    const resultado = await actualizarPagoTarjetaAdmin(token, serviceId, !habilitado);
    setProcesando(false);
    if (!resultado.ok) {
      toast.error(textoMotivo(resultado.motivo));
      return;
    }
    setHabilitado(!habilitado);
    toast.success(!habilitado ? "Pago con tarjeta activado." : "Pago con tarjeta desactivado.");
  }

  return (
    <Card className="border-none shadow-sm">
      <CardHeader>
        <div className="flex size-9 items-center justify-center rounded-xl bg-primary/10 text-primary">
          <CreditCard className="size-4" />
        </div>
        <CardTitle className="text-base">Pago con tarjeta</CardTitle>
        <CardDescription>Mostrar u ocultar la opción de pagar con tarjeta (ONVO) al cliente.</CardDescription>
      </CardHeader>
      <CardContent className="flex items-center justify-between gap-2">
        <Badge variant={habilitado ? "default" : "outline"}>{habilitado ? "Visible al cliente" : "Oculto"}</Badge>
        <Button variant="outline" size="sm" onClick={alternar} disabled={procesando}>
          {procesando ? "Guardando..." : habilitado ? "Desactivar" : "Activar"}
        </Button>
      </CardContent>
    </Card>
  );
}
