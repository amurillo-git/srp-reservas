import Link from "next/link";
import { BookingWizard } from "@/components/booking/booking-wizard";

export default function Home() {
  return (
    <div className="flex flex-1 flex-col items-center px-4 py-10 sm:py-16">
      <header className="mb-10 flex max-w-lg flex-col items-center gap-2 text-center">
        <h1 className="text-2xl font-bold tracking-tight sm:text-3xl">Reservá tu experiencia en Sarapiquí Race Park</h1>
        <p className="text-muted-foreground">
          Elegí fecha, hora y cantidad de personas para asegurar tu espacio.{" "}
          <Link href="/mi-reserva" className="font-medium text-primary underline underline-offset-4">
            ¿Ya reservaste? Consultá tu código acá.
          </Link>
        </p>
      </header>
      <BookingWizard />
    </div>
  );
}
