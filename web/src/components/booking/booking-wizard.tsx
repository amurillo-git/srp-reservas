"use client";

import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Skeleton } from "@/components/ui/skeleton";
import { listarServicios, obtenerConfiguracionPago, type ModoSinpe } from "@/lib/api";
import type { Servicio } from "@/lib/types";
import type { EstadoWizard, PasoReserva } from "./types";
import { PartySizeStep } from "./steps/party-size-step";
import { DateStep } from "./steps/date-step";
import { TimeStep } from "./steps/time-step";
import { CustomerStep } from "./steps/customer-step";
import { ReviewStep } from "./steps/review-step";
import { PaymentStep } from "./steps/payment-step";
import { ConfirmationStep } from "./steps/confirmation-step";

const PASOS: readonly { id: PasoReserva; etiqueta: string }[] = [
  { id: "personas", etiqueta: "Personas" },
  { id: "fecha", etiqueta: "Fecha" },
  { id: "hora", etiqueta: "Hora" },
  { id: "cliente", etiqueta: "Datos" },
  { id: "revision", etiqueta: "Revisión" },
  { id: "pago", etiqueta: "Pago" },
  { id: "confirmacion", etiqueta: "Listo" },
];

function nuevoEstado(servicio: Servicio): EstadoWizard {
  return {
    servicio,
    cantidadPersonas: null,
    fecha: null,
    horaInicio: null,
    cliente: null,
    plan: null,
    codigoPublico: null,
    idempotencyKey: crypto.randomUUID(),
  };
}

export function BookingWizard() {
  const [servicio, setServicio] = useState<Servicio | null | undefined>(undefined);
  const [paso, setPaso] = useState<PasoReserva>("personas");
  const [estado, setEstado] = useState<EstadoWizard | null>(null);
  const [modoSinpe, setModoSinpe] = useState<ModoSinpe>("MANUAL");

  useEffect(() => {
    listarServicios()
      .then((servicios) => {
        setServicio(servicios[0] ?? null);
        if (servicios[0]) setEstado(nuevoEstado(servicios[0]));
      })
      .catch(() => {
        toast.error("No pudimos conectar con el sistema de reservas.");
        setServicio(null);
      });
    obtenerConfiguracionPago().then(({ modoSinpe }) => setModoSinpe(modoSinpe));
  }, []);

  if (servicio === null) {
    return (
      <p className="max-w-lg text-center text-muted-foreground">
        No hay servicios disponibles para reservar en este momento. Intentá más tarde.
      </p>
    );
  }
  if (servicio === undefined || !estado) {
    return <Skeleton className="h-96 w-full max-w-lg rounded-2xl" />;
  }

  const indicePaso = PASOS.findIndex((p) => p.id === paso);

  return (
    <div className="flex w-full max-w-lg flex-col gap-6">
      {paso !== "confirmacion" && (
        <ol className="flex items-center gap-2">
          {PASOS.slice(0, -1).map((p, i) => (
            <li
              key={p.id}
              className={`h-1.5 flex-1 rounded-full transition-colors ${
                i <= indicePaso ? "bg-primary" : "bg-muted"
              }`}
              aria-current={p.id === paso}
            />
          ))}
        </ol>
      )}

      {paso === "personas" && (
        <PartySizeStep
          valorInicial={estado.cantidadPersonas}
          onSubmit={(cantidadPersonas) => {
            setEstado({ ...estado, cantidadPersonas });
            setPaso("fecha");
          }}
        />
      )}

      {paso === "fecha" && estado.cantidadPersonas && (
        <DateStep
          servicioId={servicio.id}
          cantidadPersonas={estado.cantidadPersonas}
          onSelect={(fecha) => {
            setEstado({ ...estado, fecha });
            setPaso("hora");
          }}
          onBack={() => setPaso("personas")}
        />
      )}

      {paso === "hora" && estado.fecha && estado.cantidadPersonas && (
        <TimeStep
          servicioId={servicio.id}
          fecha={estado.fecha}
          cantidadPersonas={estado.cantidadPersonas}
          onSelect={(horaInicio) => {
            setEstado({ ...estado, horaInicio });
            setPaso("cliente");
          }}
          onBack={() => setPaso("fecha")}
        />
      )}

      {paso === "cliente" && (
        <CustomerStep
          valorInicial={estado.cliente}
          onSubmit={(cliente) => {
            setEstado({ ...estado, cliente });
            setPaso("revision");
          }}
          onBack={() => setPaso("hora")}
        />
      )}

      {paso === "revision" && (
        <ReviewStep
          estado={estado}
          onBack={() => setPaso("cliente")}
          onSinDisponibilidad={() => setPaso("hora")}
          onConfirmado={(codigoPublico, plan) => {
            setEstado({ ...estado, codigoPublico, plan });
            setPaso("pago");
          }}
        />
      )}

      {paso === "pago" && estado.codigoPublico && estado.plan && (
        <PaymentStep
          codigoPublico={estado.codigoPublico}
          deposito={estado.plan.disponible ? estado.plan.precio : undefined}
          pagoTarjetaHabilitado={servicio.pagoTarjetaHabilitado}
          modoSinpe={modoSinpe}
          onReportado={() => setPaso("confirmacion")}
        />
      )}

      {paso === "confirmacion" && estado.codigoPublico && <ConfirmationStep codigoPublico={estado.codigoPublico} />}
    </div>
  );
}
