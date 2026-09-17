"use client";

import { useState } from "react";
import { History } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { obtenerEventosAuditoria, type EventoAuditoria } from "@/lib/admin-api";

const ACCIONES = [
  { valor: "", etiqueta: "Cualquier acción" },
  { valor: "RESERVA_CANCELADA", etiqueta: "Reserva cancelada" },
  { valor: "RESERVA_REPROGRAMADA", etiqueta: "Reserva reprogramada" },
  { valor: "SINPE_APROBADO", etiqueta: "SINPE aprobado" },
  { valor: "SINPE_RECHAZADO", etiqueta: "SINPE rechazado" },
  { valor: "HORARIO_SEMANAL_ACTUALIZADO", etiqueta: "Horario semanal actualizado" },
  { valor: "EXCEPCION_HORARIO_CREADA", etiqueta: "Excepción de horario creada" },
  { valor: "EXCEPCION_HORARIO_ELIMINADA", etiqueta: "Excepción de horario eliminada" },
  { valor: "BLOQUEO_CREADO", etiqueta: "Bloqueo creado" },
  { valor: "BLOQUEO_ELIMINADO", etiqueta: "Bloqueo eliminado" },
  { valor: "USUARIO_CREADO", etiqueta: "Usuario creado" },
  { valor: "USUARIO_ACTUALIZADO", etiqueta: "Usuario actualizado" },
] as const;

function formatoValores(valores: unknown): string {
  if (valores === null || valores === undefined || typeof valores !== "object") return "";
  return Object.entries(valores as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => `${k}: ${v}`)
    .join(" · ");
}

function formatoFechaHora(iso: string): string {
  return new Intl.DateTimeFormat("es-CR", { dateStyle: "short", timeStyle: "short" }).format(new Date(iso));
}

interface Filtros {
  action: string;
  objectId: string;
  from: string;
  to: string;
}

const FILTROS_VACIOS: Filtros = { action: "", objectId: "", from: "", to: "" };

export function AuditLog({ token }: { token: string }) {
  const [filtros, setFiltros] = useState<Filtros>(FILTROS_VACIOS);
  const [eventos, setEventos] = useState<readonly EventoAuditoria[] | null>(null);
  const [buscando, setBuscando] = useState(false);

  async function buscar() {
    setBuscando(true);
    const encontrados = await obtenerEventosAuditoria(token, {
      action: filtros.action || undefined,
      objectId: filtros.objectId.trim() || undefined,
      from: filtros.from || undefined,
      to: filtros.to || undefined,
    });
    setEventos(encontrados);
    setBuscando(false);
  }

  return (
    <Card className="border-none shadow-sm">
      <CardHeader>
        <div className="flex size-9 items-center justify-center rounded-xl bg-primary/10 text-primary">
          <History className="size-4" />
        </div>
        <CardTitle className="text-base">Auditoría</CardTitle>
        <CardDescription>Historial de acciones administrativas: quién, cuándo y qué cambió.</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <div className="flex flex-col gap-1">
            <Label htmlFor="auditoria-accion">Acción</Label>
            <select
              id="auditoria-accion"
              className="h-8 w-full rounded-lg border border-input bg-transparent px-2.5 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
              value={filtros.action}
              onChange={(e) => setFiltros({ ...filtros, action: e.target.value })}
            >
              {ACCIONES.map((a) => (
                <option key={a.valor} value={a.valor}>
                  {a.etiqueta}
                </option>
              ))}
            </select>
          </div>
          <div className="flex flex-col gap-1">
            <Label htmlFor="auditoria-objeto">Código de reserva u objeto</Label>
            <Input
              id="auditoria-objeto"
              value={filtros.objectId}
              onChange={(e) => setFiltros({ ...filtros, objectId: e.target.value })}
              onKeyDown={(e) => e.key === "Enter" && buscar()}
              placeholder="Ej. SRP-..."
            />
          </div>
          <div className="flex flex-col gap-1">
            <Label htmlFor="auditoria-desde">Desde</Label>
            <Input id="auditoria-desde" type="date" value={filtros.from} onChange={(e) => setFiltros({ ...filtros, from: e.target.value })} />
          </div>
          <div className="flex flex-col gap-1">
            <Label htmlFor="auditoria-hasta">Hasta</Label>
            <Input id="auditoria-hasta" type="date" value={filtros.to} onChange={(e) => setFiltros({ ...filtros, to: e.target.value })} />
          </div>
        </div>
        <Button size="sm" className="w-fit" onClick={buscar} disabled={buscando}>
          {buscando ? "Buscando..." : "Buscar"}
        </Button>

        <div className="flex flex-col gap-2 border-t pt-4">
          {eventos === null && <p className="text-sm text-muted-foreground">Buscá para ver el historial.</p>}
          {eventos !== null && eventos.length === 0 && (
            <p className="text-sm text-muted-foreground">Ningún evento coincide con esa búsqueda.</p>
          )}
          {eventos?.map((e) => (
            <div key={e.id} className="flex flex-col gap-1 rounded-lg bg-muted/50 px-3 py-2 text-sm">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <Badge variant="outline">{e.accion}</Badge>
                <span className="text-xs text-muted-foreground">{formatoFechaHora(e.creadoEn)}</span>
              </div>
              <p className="text-xs text-muted-foreground">
                {e.actorEmail ?? "Sistema"} · {e.objetoTipo} {e.objetoId}
              </p>
              {formatoValores(e.valoresNuevos) && (
                <p className="text-xs text-muted-foreground">Nuevo: {formatoValores(e.valoresNuevos)}</p>
              )}
              {formatoValores(e.valoresAnteriores) && (
                <p className="text-xs text-muted-foreground">Anterior: {formatoValores(e.valoresAnteriores)}</p>
              )}
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}
