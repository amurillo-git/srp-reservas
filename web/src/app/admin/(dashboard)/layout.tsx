"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { LogOut } from "lucide-react";
import { Button } from "@/components/ui/button";
import { borrarSesion, obtenerSesion } from "@/lib/admin-auth";

/** Protege todas las rutas de este grupo: sin sesion valida, redirige a
 * /admin/login (fuera del grupo, sin este guard). No hay servidor propio
 * (export estatico) que pueda proteger la ruta antes de servir el HTML, asi
 * que la proteccion es client-side: se muestra un estado de carga breve
 * mientras se revisa localStorage, para no destellar el contenido admin. */
export default function AdminDashboardLayout({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const [autorizado, setAutorizado] = useState(false);

  useEffect(() => {
    const sesion = obtenerSesion();
    if (!sesion) {
      router.replace("/admin/login");
      return;
    }
    setAutorizado(true);
  }, [router]);

  function cerrarSesion() {
    borrarSesion();
    router.replace("/admin/login");
  }

  if (!autorizado) return null;

  return (
    <div className="flex flex-1 flex-col">
      <header className="flex items-center justify-between border-b bg-background px-4 py-3 sm:px-6">
        <span className="font-heading text-sm font-medium">Sarapiquí Race Park — Panel administrativo</span>
        <Button variant="ghost" size="sm" onClick={cerrarSesion}>
          <LogOut data-icon="inline-start" />
          Cerrar sesión
        </Button>
      </header>
      <main className="flex-1 px-4 py-6 sm:px-6">{children}</main>
    </div>
  );
}
