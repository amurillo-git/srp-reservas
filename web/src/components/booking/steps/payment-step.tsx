"use client";

import { useEffect, useState, type FormEvent } from "react";
import { CreditCard, Landmark, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import { formatoMoneda } from "@/lib/format";
import {
  consultarReserva,
  iniciarIntencionSinpe,
  iniciarPagoTarjeta,
  reportarComprobanteSinpe,
  type ModoSinpe,
} from "@/lib/api";

const SINPE_PHONE = process.env.NEXT_PUBLIC_SINPE_PHONE ?? "0000-0000";
const MINUTOS_RETENCION = 30;

export function PaymentStep({
  codigoPublico,
  deposito,
  pagoTarjetaHabilitado,
  modoSinpe,
  segundosRestantesIniciales = MINUTOS_RETENCION * 60,
  onReportado,
}: {
  codigoPublico: string;
  deposito?: { readonly montoDeposito: number; readonly moneda: string };
  pagoTarjetaHabilitado: boolean;
  modoSinpe: ModoSinpe;
  /** Permite reanudar el conteo desde donde vaya la retención real (14.8),
   * en vez de siempre arrancar en 30:00. */
  segundosRestantesIniciales?: number;
  onReportado: () => void;
}) {
  const [iniciandoTarjeta, setIniciandoTarjeta] = useState(false);
  const [segundosRestantes, setSegundosRestantes] = useState(segundosRestantesIniciales);

  useEffect(() => {
    const id = setInterval(() => setSegundosRestantes((s) => Math.max(0, s - 1)), 1000);
    return () => clearInterval(id);
  }, []);

  const minutos = String(Math.floor(segundosRestantes / 60)).padStart(2, "0");
  const segundos = String(segundosRestantes % 60).padStart(2, "0");

  async function pagarConTarjeta() {
    setIniciandoTarjeta(true);
    const resultado = await iniciarPagoTarjeta(codigoPublico);
    if (!resultado.ok) {
      setIniciandoTarjeta(false);
      toast.error("No pudimos iniciar el pago con tarjeta. Intentá de nuevo.");
      return;
    }
    window.location.href = resultado.checkoutUrl;
  }

  return (
    <Card className="border-none shadow-sm">
      <CardHeader>
        <div className="flex size-11 items-center justify-center rounded-2xl bg-primary/10 text-primary">
          <Landmark className="size-5" />
        </div>
        <CardTitle className="text-xl">Pagá el depósito por SINPE Móvil</CardTitle>
        <CardDescription>
          Código de reserva <span className="font-semibold text-foreground">{codigoPublico}</span> — tenés {minutos}:{segundos} para
          completar el pago.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-6">
        {pagoTarjetaHabilitado && (
          <>
            <Button type="button" size="lg" variant="outline" className="rounded-2xl" onClick={pagarConTarjeta} disabled={iniciandoTarjeta}>
              <CreditCard data-icon="inline-start" />
              {iniciandoTarjeta ? "Redirigiendo..." : "Pagar con tarjeta"}
            </Button>
            <div className="flex items-center gap-3 text-xs text-muted-foreground">
              <Separator className="flex-1" />
              o pagá por SINPE Móvil
              <Separator className="flex-1" />
            </div>
          </>
        )}

        {modoSinpe === "MANUAL" ? (
          <PagoSinpeManual codigoPublico={codigoPublico} deposito={deposito} onReportado={onReportado} />
        ) : (
          <PagoSinpeOnvo codigoPublico={codigoPublico} deposito={deposito} onConfirmado={onReportado} />
        )}
      </CardContent>
    </Card>
  );
}

function PagoSinpeManual({
  codigoPublico,
  deposito,
  onReportado,
}: {
  codigoPublico: string;
  deposito?: { readonly montoDeposito: number; readonly moneda: string };
  onReportado: () => void;
}) {
  const [nombrePagador, setNombrePagador] = useState("");
  const [numeroOrigen, setNumeroOrigen] = useState("");
  const [referencia, setReferencia] = useState("");
  const [enviando, setEnviando] = useState(false);

  async function manejarEnvio(evento: FormEvent) {
    evento.preventDefault();
    setEnviando(true);
    try {
      const resultado = await reportarComprobanteSinpe(codigoPublico, {
        nombrePagador: nombrePagador.trim() || undefined,
        numeroOrigen: numeroOrigen.trim() || undefined,
        referencia: referencia.trim() || undefined,
      });
      if (resultado.ok) {
        onReportado();
        return;
      }
      toast.error("No pudimos registrar el comprobante. Intentá de nuevo.");
    } finally {
      setEnviando(false);
    }
  }

  return (
    <>
      <div className="rounded-2xl bg-accent p-4 text-sm">
        <div className="flex items-center justify-between">
          <span>Número SINPE</span>
          <span className="font-semibold">{SINPE_PHONE}</span>
        </div>
        {deposito && (
          <div className="mt-1 flex items-center justify-between">
            <span>Monto a transferir</span>
            <span className="font-semibold text-primary">{formatoMoneda(deposito.montoDeposito, deposito.moneda)}</span>
          </div>
        )}
      </div>

      <Separator />

      <form className="flex flex-col gap-4" onSubmit={manejarEnvio}>
        <p className="text-muted-foreground text-sm">
          Una vez hecha la transferencia, contanos los datos para que podamos validarla.
        </p>
        <div className="flex flex-col gap-2">
          <Label htmlFor="nombrePagador">Nombre de quien pagó</Label>
          <Input id="nombrePagador" value={nombrePagador} onChange={(e) => setNombrePagador(e.target.value)} className="rounded-xl" />
        </div>
        <div className="flex flex-col gap-2">
          <Label htmlFor="numeroOrigen">Número desde donde se envió</Label>
          <Input id="numeroOrigen" value={numeroOrigen} onChange={(e) => setNumeroOrigen(e.target.value)} className="rounded-xl" />
        </div>
        <div className="flex flex-col gap-2">
          <Label htmlFor="referencia">Referencia / comprobante</Label>
          <Input id="referencia" value={referencia} onChange={(e) => setReferencia(e.target.value)} className="rounded-xl" />
        </div>
        <Button type="submit" size="lg" className="mt-2 rounded-2xl" disabled={enviando}>
          {enviando ? "Enviando..." : "Ya pagué, reportar comprobante"}
        </Button>
      </form>
    </>
  );
}

/** SINPE automático via ONVO (25): a diferencia del manual, ONVO exige la
 * cédula del cliente (no solo el teléfono) para poder asociar la
 * transferencia que llegue. Una vez creada la intención, no hay redirect
 * (a diferencia de tarjeta): se espera en la misma pantalla, consultando la
 * reserva cada pocos segundos hasta que el webhook la confirme. */
function PagoSinpeOnvo({
  codigoPublico,
  deposito,
  onConfirmado,
}: {
  codigoPublico: string;
  deposito?: { readonly montoDeposito: number; readonly moneda: string };
  onConfirmado: () => void;
}) {
  const [telefono, setTelefono] = useState("");
  const [cedula, setCedula] = useState("");
  const [enviando, setEnviando] = useState(false);
  const [intencion, setIntencion] = useState<{ numeroSinpe: string; monto: number; moneda: string } | null>(null);

  useEffect(() => {
    if (!intencion) return;
    const id = setInterval(async () => {
      const reserva = await consultarReserva(codigoPublico);
      if (reserva && reserva.estado !== "TEMPORAL") {
        clearInterval(id);
        onConfirmado();
      }
    }, 5000);
    return () => clearInterval(id);
  }, [intencion, codigoPublico, onConfirmado]);

  async function manejarEnvio(evento: FormEvent) {
    evento.preventDefault();
    setEnviando(true);
    const resultado = await iniciarIntencionSinpe(codigoPublico, { telefono: telefono.trim(), cedula: cedula.trim() });
    setEnviando(false);
    if (!resultado.ok) {
      toast.error("No pudimos iniciar el pago SINPE. Revisá los datos e intentá de nuevo.");
      return;
    }
    setIntencion({ numeroSinpe: resultado.numeroSinpe, monto: resultado.monto, moneda: resultado.moneda });
  }

  if (intencion) {
    return (
      <div className="flex flex-col gap-4">
        <div className="rounded-2xl bg-accent p-4 text-sm">
          <div className="flex items-center justify-between">
            <span>Número SINPE</span>
            <span className="font-semibold">{intencion.numeroSinpe}</span>
          </div>
          <div className="mt-1 flex items-center justify-between">
            <span>Monto a transferir</span>
            <span className="font-semibold text-primary">{formatoMoneda(intencion.monto, intencion.moneda)}</span>
          </div>
        </div>
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin" />
          Esperando que se confirme la transferencia...
        </div>
      </div>
    );
  }

  return (
    <form className="flex flex-col gap-4" onSubmit={manejarEnvio}>
      <p className="text-muted-foreground text-sm">
        Ingresá tus datos para generar el pago — ONVO confirma la transferencia automáticamente.
      </p>
      <div className="flex flex-col gap-2">
        <Label htmlFor="telefono">Teléfono SINPE (desde el que vas a transferir)</Label>
        <Input
          id="telefono"
          value={telefono}
          onChange={(e) => setTelefono(e.target.value)}
          placeholder="+506XXXXXXXX"
          className="rounded-xl"
          required
        />
      </div>
      <div className="flex flex-col gap-2">
        <Label htmlFor="cedula">Cédula</Label>
        <Input id="cedula" value={cedula} onChange={(e) => setCedula(e.target.value)} className="rounded-xl" required />
      </div>
      {deposito && (
        <p className="text-sm text-muted-foreground">
          Monto del depósito: <span className="font-semibold text-foreground">{formatoMoneda(deposito.montoDeposito, deposito.moneda)}</span>
        </p>
      )}
      <Button type="submit" size="lg" className="mt-2 rounded-2xl" disabled={enviando}>
        {enviando ? "Generando..." : "Generar pago SINPE"}
      </Button>
    </form>
  );
}
