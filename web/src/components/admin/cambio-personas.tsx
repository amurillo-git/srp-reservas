"use client";

import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  cambiarPersonasAdmin,
  consultarOpcionesCambioPersonasAdmin,
  type HeatResumen,
  type ModoCambioPersonas,
  type OpcionesCambioPersonas,
} from "@/lib/admin-api";
import { formatoHora12, formatoMoneda } from "@/lib/format";

/** Motivos tecnicos del backend traducidos a texto para el administrador. */
const MOTIVOS: Record<string, string> = {
  NO_ENCONTRADA: "No se encontró esa reserva.",
  ESTADO_INVALIDO: "Esa reserva ya no se puede modificar en su estado actual.",
  CANTIDAD_INVALIDA: "La cantidad debe ser un número mayor a la actual.",
  DECISION_REQUERIDA: "Elegí cómo acomodar al grupo.",
  REPARTO_NO_DISPONIBLE: "Ya no hay lugar para repartir al grupo. Probá con todos en el mismo slot.",
  CONFLICTO_CONCURRENCIA: "La disponibilidad cambió justo ahora — probá de nuevo.",
};

function textoMotivo(motivo: string): string {
  return MOTIVOS[motivo] ?? motivo;
}

/** "8 a las 9:00 AM" o, con varios heats, "4 a las 9:00 AM + 4 a las 9:15 AM". */
function textoHeats(heats: readonly HeatResumen[]): string {
  return heats.map((h) => `${h.personas} a las ${formatoHora12(h.horaInicio)}`).join(" + ");
}

export interface ResultadoCambioAplicado {
  readonly cantidadPersonas: number;
  readonly montoTotal: number;
  readonly montoSaldo: number;
}

/** Sube la cantidad de personas de una reserva por encima del limite de 5 por
 * heat (excepcion del administrador). Consulta las opciones (solo lectura) y,
 * si algun heat pasaria de la capacidad normal, obliga a elegir entre dejar a
 * todos en el mismo slot o repartirlos equitativamente. "Repartir" aparece
 * deshabilitado si choca con otras reservas. Con `cantidadInicial` omite el
 * paso de escribir la cantidad (ej. al cobrar el saldo, cuando el
 * administrador ya indico cuantos llegaron). */
export function CambioPersonas({
  token,
  codigoPublico,
  cantidadActual,
  cantidadInicial,
  onAplicado,
  onCancelar,
}: {
  token: string;
  codigoPublico: string;
  cantidadActual: number;
  cantidadInicial?: number;
  onAplicado: (resultado: ResultadoCambioAplicado) => void;
  onCancelar: () => void;
}) {
  const [cantidad, setCantidad] = useState(String(cantidadInicial ?? cantidadActual + 1));
  const [consultada, setConsultada] = useState<number | null>(null);
  const [opciones, setOpciones] = useState<OpcionesCambioPersonas | null>(null);
  const [modo, setModo] = useState<ModoCambioPersonas | null>(null);
  const [cargando, setCargando] = useState(false);
  const [aplicando, setAplicando] = useState(false);

  async function consultar(numero: number): Promise<void> {
    if (!Number.isInteger(numero) || numero <= cantidadActual) {
      toast.error(`Ingresá un número mayor a ${cantidadActual}.`);
      return;
    }
    setCargando(true);
    const resultado = await consultarOpcionesCambioPersonasAdmin(token, codigoPublico, numero);
    setCargando(false);
    if (!resultado.ok) {
      toast.error(textoMotivo(resultado.motivo));
      if (cantidadInicial !== undefined) onCancelar();
      return;
    }
    setOpciones(resultado.opciones);
    setConsultada(numero);
    setModo(null);
  }

  useEffect(() => {
    if (cantidadInicial !== undefined) void consultar(cantidadInicial);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function aplicar() {
    if (!opciones || consultada === null) return;
    if (opciones.requiereDecision && !modo) {
      toast.error(textoMotivo("DECISION_REQUERIDA"));
      return;
    }
    setAplicando(true);
    const resultado = await cambiarPersonasAdmin(
      token,
      codigoPublico,
      consultada,
      opciones.requiereDecision ? (modo ?? undefined) : undefined,
    );
    setAplicando(false);
    if (!resultado.ok) {
      toast.error(textoMotivo(resultado.motivo));
      // Lo consultado puede haber quedado viejo: se vuelve a consultar.
      if (resultado.motivo === "REPARTO_NO_DISPONIBLE" || resultado.motivo === "CONFLICTO_CONCURRENCIA") {
        await consultar(consultada);
      }
      return;
    }
    toast.success(`Cantidad actualizada: ${consultada} personas.`);
    onAplicado({ cantidadPersonas: consultada, montoTotal: resultado.montoTotal, montoSaldo: resultado.montoSaldo });
  }

  if (!opciones) {
    if (cantidadInicial !== undefined) {
      return (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin" />
          Consultando opciones...
        </div>
      );
    }
    return (
      <div className="flex flex-col gap-3">
        <div className="flex flex-col gap-1">
          <Label htmlFor={`nueva-cantidad-${codigoPublico}`}>Nueva cantidad de personas</Label>
          <Input
            id={`nueva-cantidad-${codigoPublico}`}
            type="number"
            min={cantidadActual + 1}
            value={cantidad}
            onChange={(e) => setCantidad(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && consultar(Number(cantidad))}
          />
          <p className="text-xs text-muted-foreground">
            Hoy hay {cantidadActual} personas. Solo se puede subir la cantidad.
          </p>
        </div>
        <div className="flex gap-2">
          <Button size="sm" onClick={() => consultar(Number(cantidad))} disabled={cargando}>
            {cargando ? "Consultando..." : "Continuar"}
          </Button>
          <Button size="sm" variant="ghost" onClick={onCancelar} disabled={cargando}>
            Cancelar
          </Button>
        </div>
      </div>
    );
  }

  const repartir = opciones.repartir;
  return (
    <div className="flex flex-col gap-3">
      <p className="text-sm">
        Nueva cantidad: <span className="font-semibold">{consultada} personas</span> (hoy {cantidadActual}). Nuevo total{" "}
        <span className="font-semibold">{formatoMoneda(opciones.montoTotal, opciones.moneda)}</span> · saldo pendiente{" "}
        <span className="font-semibold">{formatoMoneda(opciones.montoSaldo, opciones.moneda)}</span>.
      </p>

      {opciones.requiereDecision ? (
        <fieldset className="flex flex-col gap-2">
          <legend className="mb-1 text-sm font-medium">
            Algún heat pasaría de 5 personas. ¿Cómo acomodamos al grupo?
          </legend>
          <label className="flex cursor-pointer items-start gap-2 rounded-lg border p-2 text-sm">
            <input
              type="radio"
              name={`modo-${codigoPublico}`}
              className="mt-1 accent-primary"
              checked={modo === "SAME_SLOT"}
              onChange={() => setModo("SAME_SLOT")}
              disabled={aplicando}
            />
            <span>
              <span className="font-medium">Todos en el mismo slot</span>
              <span className="block text-xs text-muted-foreground">{textoHeats(opciones.mismoSlot)}</span>
            </span>
          </label>
          <label
            className={`flex items-start gap-2 rounded-lg border p-2 text-sm ${
              repartir?.disponible ? "cursor-pointer" : "cursor-not-allowed opacity-60"
            }`}
          >
            <input
              type="radio"
              name={`modo-${codigoPublico}`}
              className="mt-1 accent-primary"
              checked={modo === "SPLIT"}
              onChange={() => setModo("SPLIT")}
              disabled={aplicando || !repartir?.disponible}
            />
            <span>
              <span className="font-medium">Repartir equitativamente</span>
              <span className="block text-xs text-muted-foreground">
                {repartir?.disponible
                  ? textoHeats(repartir.heats)
                  : repartir?.motivo === "ESTRUCTURA_NO_SOPORTADA"
                    ? "No disponible para esta reserva."
                    : "No disponible: choca con otras reservas."}
              </span>
            </span>
          </label>
        </fieldset>
      ) : (
        <p className="text-sm text-muted-foreground">
          Todos caben en sus heats actuales: {textoHeats(opciones.mismoSlot)}.
        </p>
      )}

      <div className="flex gap-2">
        <Button size="sm" onClick={aplicar} disabled={aplicando || (opciones.requiereDecision && !modo)}>
          {aplicando ? "Aplicando..." : "Aplicar cambio"}
        </Button>
        {cantidadInicial === undefined && (
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              setOpciones(null);
              setConsultada(null);
            }}
            disabled={aplicando}
          >
            Atrás
          </Button>
        )}
        <Button size="sm" variant="ghost" onClick={onCancelar} disabled={aplicando}>
          Cancelar
        </Button>
      </div>
    </div>
  );
}
