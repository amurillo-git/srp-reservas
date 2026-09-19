"use client";

import { useEffect, useState } from "react";
import { Landmark } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  actualizarConfiguracionPagoAdmin,
  obtenerConfiguracionPagoAdmin,
  type ModoSinpe,
} from "@/lib/admin-api";

const ETIQUETA: Record<ModoSinpe, string> = {
  MANUAL: "Manual (revisás cada comprobante)",
  ONVO: "Automático con ONVO",
};

export function SinpeModeToggle({ token }: { token: string }) {
  const [modo, setModo] = useState<ModoSinpe | null>(null);
  const [guardando, setGuardando] = useState(false);

  useEffect(() => {
    obtenerConfiguracionPagoAdmin(token).then(setModo);
  }, [token]);

  async function cambiar(nuevo: ModoSinpe) {
    if (modo === nuevo) return;
    setGuardando(true);
    const resultado = await actualizarConfiguracionPagoAdmin(token, nuevo);
    setGuardando(false);
    if (!resultado.ok) {
      toast.error("No se pudo cambiar el modo de SINPE.");
      return;
    }
    setModo(nuevo);
    toast.success(`SINPE ahora en modo ${ETIQUETA[nuevo]}.`);
  }

  return (
    <Card className="border-none shadow-sm">
      <CardHeader>
        <div className="flex size-9 items-center justify-center rounded-xl bg-primary/10 text-primary">
          <Landmark className="size-4" />
        </div>
        <CardTitle className="text-base">Confirmación de SINPE Móvil</CardTitle>
        <CardDescription>
          Manual: revisás el comprobante y confirmás vos. Automático: ONVO detecta la transferencia y confirma solo.
          Nunca los dos a la vez.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {modo === null ? (
          <p className="text-sm text-muted-foreground">Cargando...</p>
        ) : (
          <>
            <div className="flex items-center gap-2">
              <span className="text-sm text-muted-foreground">Modo actual:</span>
              <Badge variant="default">{ETIQUETA[modo]}</Badge>
            </div>
            <div className="flex flex-wrap gap-2">
              <Button
                variant={modo === "MANUAL" ? "default" : "outline"}
                size="sm"
                disabled={guardando}
                onClick={() => cambiar("MANUAL")}
              >
                Manual
              </Button>
              <Button
                variant={modo === "ONVO" ? "default" : "outline"}
                size="sm"
                disabled={guardando}
                onClick={() => cambiar("ONVO")}
              >
                Automático con ONVO
              </Button>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}
