"use client";

import { useEffect, useState } from "react";
import { CalendarClock } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { establecerPlantillaSemanal, obtenerPlantillaSemanal, type PlantillaSemanal } from "@/lib/admin-api";

const DIAS = ["Domingo", "Lunes", "Martes", "Miércoles", "Jueves", "Viernes", "Sábado"];

interface FormularioDia {
  horaApertura: string;
  horaCierre: string;
  almuerzoInicio: string;
  almuerzoFin: string;
  activo: boolean;
}

function aFormulario(p: PlantillaSemanal | undefined): FormularioDia {
  return {
    horaApertura: p?.horaApertura ?? "09:00",
    horaCierre: p?.horaCierre ?? "16:00",
    almuerzoInicio: p?.almuerzoInicio ?? "",
    almuerzoFin: p?.almuerzoFin ?? "",
    activo: p?.activo ?? true,
  };
}

export function WeeklySchedule({ token, serviceId }: { token: string; serviceId: string }) {
  const [plantillas, setPlantillas] = useState<readonly PlantillaSemanal[] | null>(null);
  const [diaEditando, setDiaEditando] = useState<number | null>(null);
  const [formulario, setFormulario] = useState<FormularioDia | null>(null);
  const [guardando, setGuardando] = useState(false);

  useEffect(() => {
    obtenerPlantillaSemanal(token, serviceId).then(setPlantillas);
  }, [token, serviceId]);

  function abrirEdicion(dia: number) {
    setDiaEditando(dia);
    setFormulario(aFormulario(plantillas?.find((p) => p.diaSemana === dia)));
  }

  async function guardar(dia: number) {
    if (!formulario) return;
    setGuardando(true);
    const resultado = await establecerPlantillaSemanal(token, serviceId, dia, {
      openTime: formulario.horaApertura,
      closeTime: formulario.horaCierre,
      lunchStart: formulario.almuerzoInicio || undefined,
      lunchEnd: formulario.almuerzoFin || undefined,
      active: formulario.activo,
    });
    setGuardando(false);
    if (!resultado.ok) {
      toast.error(resultado.motivo ?? "No se pudo guardar el horario.");
      return;
    }
    const actualizadas = await obtenerPlantillaSemanal(token, serviceId);
    setPlantillas(actualizadas);
    setDiaEditando(null);
    toast.success(`Horario de ${DIAS[dia]} actualizado.`);
  }

  return (
    <Card className="border-none shadow-sm">
      <CardHeader>
        <div className="flex size-9 items-center justify-center rounded-xl bg-primary/10 text-primary">
          <CalendarClock className="size-4" />
        </div>
        <CardTitle className="text-base">Horario semanal</CardTitle>
        <CardDescription>Horario habitual por día. Los cambios no afectan reservas ya hechas.</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-2">
        {plantillas === null && <p className="text-sm text-muted-foreground">Cargando...</p>}
        {plantillas !== null &&
          DIAS.map((nombre, dia) => {
            const plantilla = plantillas.find((p) => p.diaSemana === dia);
            const editando = diaEditando === dia;
            return (
              <div key={dia} className="rounded-lg bg-muted/50 p-3 text-sm">
                <div className="flex items-center justify-between gap-2">
                  <span className="font-medium">{nombre}</span>
                  {!editando && (
                    <div className="flex items-center gap-2">
                      <span className="text-muted-foreground">
                        {plantilla && plantilla.activo
                          ? `${plantilla.horaApertura}–${plantilla.horaCierre}${plantilla.almuerzoInicio ? ` (almuerzo ${plantilla.almuerzoInicio}–${plantilla.almuerzoFin})` : ""}`
                          : "Cerrado"}
                      </span>
                      <Button variant="outline" size="xs" onClick={() => abrirEdicion(dia)}>
                        Editar
                      </Button>
                    </div>
                  )}
                </div>
                {editando && formulario && (
                  <div className="mt-3 flex flex-col gap-3">
                    <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                      <div className="flex flex-col gap-1">
                        <Label htmlFor={`apertura-${dia}`}>Apertura</Label>
                        <Input
                          id={`apertura-${dia}`}
                          type="time"
                          value={formulario.horaApertura}
                          onChange={(e) => setFormulario({ ...formulario, horaApertura: e.target.value })}
                        />
                      </div>
                      <div className="flex flex-col gap-1">
                        <Label htmlFor={`cierre-${dia}`}>Cierre</Label>
                        <Input
                          id={`cierre-${dia}`}
                          type="time"
                          value={formulario.horaCierre}
                          onChange={(e) => setFormulario({ ...formulario, horaCierre: e.target.value })}
                        />
                      </div>
                      <div className="flex flex-col gap-1">
                        <Label htmlFor={`almuerzo-inicio-${dia}`}>Almuerzo desde</Label>
                        <Input
                          id={`almuerzo-inicio-${dia}`}
                          type="time"
                          value={formulario.almuerzoInicio}
                          onChange={(e) => setFormulario({ ...formulario, almuerzoInicio: e.target.value })}
                        />
                      </div>
                      <div className="flex flex-col gap-1">
                        <Label htmlFor={`almuerzo-fin-${dia}`}>Almuerzo hasta</Label>
                        <Input
                          id={`almuerzo-fin-${dia}`}
                          type="time"
                          value={formulario.almuerzoFin}
                          onChange={(e) => setFormulario({ ...formulario, almuerzoFin: e.target.value })}
                        />
                      </div>
                    </div>
                    <label className="flex items-center gap-2 text-sm">
                      <input
                        type="checkbox"
                        checked={formulario.activo}
                        onChange={(e) => setFormulario({ ...formulario, activo: e.target.checked })}
                      />
                      Abierto este día
                    </label>
                    <div className="flex gap-2">
                      <Button size="sm" onClick={() => guardar(dia)} disabled={guardando}>
                        {guardando ? "Guardando..." : "Guardar"}
                      </Button>
                      <Button size="sm" variant="ghost" onClick={() => setDiaEditando(null)} disabled={guardando}>
                        Cancelar
                      </Button>
                    </div>
                  </div>
                )}
              </div>
            );
          })}
      </CardContent>
    </Card>
  );
}
