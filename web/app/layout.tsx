import type { Metadata } from "next";

import "./globals.css";

export const metadata: Metadata = {
  title: "openRanks — montar un TOP 5",
  description:
    "Sube 5 clips, escribe el título y los nombres de los puestos, y el motor los une y les añade la edición del formato.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="es">
      <body>{children}</body>
    </html>
  );
}
