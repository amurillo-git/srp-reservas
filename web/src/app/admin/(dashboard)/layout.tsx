"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { LogOut } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "cn";
import { borrarSesion, obtenerSesion } from "@/lib/admin-auth";

const ENLACES = [
  { href: "/admin", etiqueta: "Inicio" },
  { href: "/admin/schedule", etiqueta: "Horarios y bloqueos" },
] as const;

/** Protege todas las rutas de este grupo: sin sesion valida, redirige a
 * /admin/login (fuera del grupo, sin este guard). No hay servidor propio
 * (export estatico) que pueda proteger la ruta antes de servir el HTML, asi
 * que la proteccion es client-side: se muestra un estado de carga breve
 * mientras se revisa localStorage, para no destellar el contenido admin. */
export default function AdminDashboardLayout({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
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
      <header className="flex flex-col gap-3 border-b bg-background px-4 py-3 sm:flex-row sm:items-center sm:justify-between sm:px-6">
        <span className="font-heading text-sm font-medium">Sarapiquí Race Park — Panel administrativo</span>
        <nav className="flex items-center gap-1">
          {ENLACES.map((enlace) => (
            <Link
              key={enlace.href}
              href={enlace.href}
              className={cn(
                "rounded-lg px-2.5 py-1 text-sm font-medium transition-colors hover:bg-muted",
                pathname === enlace.href && "bg-muted text-foreground",
              )}
            >
              {enlace.etiqueta}
            </Link>
          ))}
        </nav>
        <Button variant="ghost" size="sm" onClick={cerrarSesion} className="w-fit">
          <LogOut data-icon="inline-start" />
          Cerrar sesión
        </Button>
      </header>
      <main className="flex-1 px-4 py-6 sm:px-6">{children}</main>
    </div>
  );
}
