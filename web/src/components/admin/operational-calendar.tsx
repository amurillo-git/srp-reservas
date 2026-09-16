"use client";

import { useEffect, useState } from "react";
import { CalendarDays, ChevronLeft, ChevronRight } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  obtenerCalendarioOperativo,
  type CalendarioOperativoDelDia,
  type HeatOperativo,
} from "@/lib/admin-api";
import { hoyISO } from "@/lib/format";

const DIAS_CORTOS = ["Dom", "Lun", "Mar", "Mié", "Jue", "Vie", "Sáb"];

const VARIANTE_POR_ESTADO_RESERVA: Record<string, "default" | "outline" | "destructive"> = {
  CONFIRMADA: "default",
  CANCELADA: "destructive",
  RECHAZADA: "destructive",
  EXPIRADA: "destructive",
};

function sumarDias(fechaISO: string, dias: number): string {
  const fecha = new Date(`${fechaISO}T00:00:00.000Z`);
  fecha.setUTCDate(fecha.getUTCDate() + dias);
  return fecha.toISOString().slice(0, 10);
}

function inicioDeSemana(fechaISO: string): string {
  const fecha = new Date(`${fechaISO}T00:00:00.000Z`);
  return sumarDias(fechaISO, -fecha.getUTCDay());
}

function ocupadosDeHeat(heat: HeatOperativo): number {
  return heat.reservas.reduce((suma, r) => suma + r.cantidadPersonas, 0);
}

function estadoOcupacion(heat: HeatOperativo): "LIBRE" | "PARCIAL" | "COMPLETO" {
  const ocupados = ocupadosDeHeat(heat);
  if (ocupados === 0) return "LIBRE";
  return ocupados >= heat.capacidadMaxima ? "COMPLETO" : "PARCIAL";
}

const VARIANTE_POR_OCUPACION: Record<string, "outline" | "default" | "destructive"> = {
  LIBRE: "outline",
  PARCIAL: "default",
  COMPLETO: "destructive",
};

interface ResumenDia {
  readonly cerrado: boolean;
  readonly lotes: number;
  readonly heatsTotal: number;
  readonly heatsCompletos: number;
  readonly participantes: number;
}

function resumirDia(cal: CalendarioOperativoDelDia): ResumenDia {
  const heats = cal.lotes.flatMap((l) => l.heats);
  return {
    cerrado: cal.ventanas.length === 0,
    lotes: cal.lotes.length,
    heatsTotal: heats.length,
    heatsCompletos: heats.filter((h) => estadoOcupacion(h) === "COMPLETO").length,
    participantes: heats.reduce((suma, h) => suma + ocupadosDeHeat(h), 0),
  };
}

export function OperationalCalendar({ token, serviceId }: { token: string; serviceId: string }) {
  const [fecha, setFecha] = useState(hoyISO());
  const [calendario, setCalendario] = useState<CalendarioOperativoDelDia | null>(null);
  const [heatExpandido, setHeatExpandido] = useState<string | null>(null);
  const [resumenSemana, setResumenSemana] = useState<Record<string, ResumenDia | null>>({});

  const inicioSemana = inicioDeSemana(fecha);
  const diasSemana = Array.from({ length: 7 }, (_, i) => sumarDias(inicioSemana, i));

  useEffect(() => {
    setCalendario(null);
    setHeatExpandido(null);
    obtenerCalendarioOperativo(token, serviceId, fecha).then(setCalendario);
  }, [token, serviceId, fecha]);

  useEffect(() => {
    setResumenSemana({});
    let cancelado = false;
    for (const dia of diasSemana) {
      obtenerCalendarioOperativo(token, serviceId, dia).then((cal) => {
        if (cancelado) return;
        setResumenSemana((actual) => ({ ...actual, [dia]: resumirDia(cal) }));
      });
    }
    return () => {
      cancelado = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token, serviceId, inicioSemana]);

  return (
    <Card className="border-none shadow-sm">
      <CardHeader>
        <div className="flex size-9 items-center justify-center rounded-xl bg-primary/10 text-primary">
          <CalendarDays className="size-4" />
        </div>
        <CardTitle className="text-base">Calendario operativo</CardTitle>
        <CardDescription>Lotes, heats y ocupación por día.</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <div className="flex items-center justify-between gap-2">
          <Button variant="ghost" size="icon-sm" onClick={() => setFecha(sumarDias(inicioSemana, -7))}>
            <ChevronLeft />
          </Button>
          <span className="text-sm font-medium">Semana del {inicioSemana}</span>
          <Button variant="ghost" size="icon-sm" onClick={() => setFecha(sumarDias(inicioSemana, 7))}>
            <ChevronRight />
          </Button>
        </div>

        <div className="grid grid-cols-7 gap-1">
          {diasSemana.map((dia, i) => {
            const resumen = resumenSemana[dia];
            const activo = dia === fecha;
            return (
              <button
                key={dia}
                onClick={() => setFecha(dia)}
                className={`flex flex-col items-center gap-1 rounded-lg border px-1 py-2 text-center text-xs transition-colors ${
                  activo ? "border-primary bg-primary/10" : "border-transparent bg-muted/50 hover:bg-muted"
                }`}
              >
                <span className="font-medium">{DIAS_CORTOS[i]}</span>
                <span className="text-muted-foreground">{dia.slice(8, 10)}</span>
                {resumen === undefined && <span className="text-muted-foreground">...</span>}
                {resumen && resumen.cerrado && <span className="text-muted-foreground">Cerrado</span>}
                {resumen && !resumen.cerrado && (
                  <span className="leading-tight text-muted-foreground">
                    {resumen.lotes}L · {resumen.heatsTotal}H · {resumen.participantes}p
                  </span>
                )}
              </button>
            );
          })}
        </div>

        <div className="flex flex-col gap-1 border-t pt-3">
          <Label htmlFor="calendario-fecha">Día</Label>
          <Input id="calendario-fecha" type="date" value={fecha} onChange={(e) => setFecha(e.target.value)} className="max-w-48" />
        </div>

        {calendario === null && <p className="text-sm text-muted-foreground">Cargando...</p>}

        {calendario !== null && calendario.ventanas.length === 0 && (
          <p className="text-sm text-muted-foreground">Este día está cerrado.</p>
        )}

        {calendario !== null &&
          calendario.ventanas.map((v, i) => (
            <p key={i} className="text-sm text-muted-foreground">
              Horario: {v.horaApertura}–{v.horaCierre}
              {v.almuerzoInicio ? ` (almuerzo ${v.almuerzoInicio}–${v.almuerzoFin})` : ""}
            </p>
          ))}

        {calendario !== null && calendario.lotes.length === 0 && calendario.ventanas.length > 0 && (
          <p className="text-sm text-muted-foreground">Sin lotes programados este día.</p>
        )}

        {calendario?.lotes.map((lote) => (
          <div key={lote.loteId} className="flex flex-col gap-2 rounded-lg bg-muted/50 p-3 text-sm">
            <p className="font-medium">
              Lote {lote.horaInicio}–{lote.horaFinUltimoHeat}
              <span className="ml-2 font-normal text-muted-foreground">
                limpieza {lote.horaInicioLimpieza}–{lote.horaFinLimpieza}
              </span>
            </p>
            <div className="flex flex-col gap-1">
              {lote.heats.map((heat) => {
                const expandido = heatExpandido === heat.heatId;
                const ocupados = ocupadosDeHeat(heat);
                return (
                  <div key={heat.heatId} className="rounded-lg bg-background px-3 py-2">
                    <button
                      className="flex w-full items-center justify-between gap-2"
                      onClick={() => setHeatExpandido(expandido ? null : heat.heatId)}
                    >
                      <span>{heat.horaInicio}</span>
                      <span className="flex items-center gap-2">
                        <span className="text-xs text-muted-foreground">
                          {ocupados}/{heat.capacidadMaxima}
                        </span>
                        <Badge variant={VARIANTE_POR_OCUPACION[estadoOcupacion(heat)]}>{estadoOcupacion(heat)}</Badge>
                      </span>
                    </button>
                    {expandido && (
                      <div className="mt-2 flex flex-col gap-1 border-t pt-2">
                        {heat.reservas.length === 0 && <p className="text-xs text-muted-foreground">Sin reservas.</p>}
                        {heat.reservas.map((r) => (
                          <div key={r.codigoPublico} className="flex items-center justify-between gap-2 text-xs">
                            <span>
                              {r.codigoPublico} · {r.cantidadPersonas} personas
                            </span>
                            <Badge variant={VARIANTE_POR_ESTADO_RESERVA[r.estado] ?? "outline"}>{r.estado}</Badge>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        ))}

        {calendario !== null && calendario.bloqueos.length > 0 && (
          <div className="flex flex-col gap-1 border-t pt-3">
            <p className="text-sm font-medium">Bloqueos administrativos</p>
            {calendario.bloqueos.map((b) => (
              <div key={b.id} className="flex items-center justify-between gap-2 rounded-lg bg-muted/50 px-3 py-2 text-sm">
                <span>
                  {b.horaInicio}–{b.horaFin}
                </span>
                <span className="text-xs text-muted-foreground">{b.motivo ?? "Sin motivo"}</span>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
