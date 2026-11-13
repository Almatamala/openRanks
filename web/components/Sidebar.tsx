"use client";

import { useEffect, useState, type ReactElement, type ReactNode } from "react";

/** Secciones del panel. La navegación no usa rutas: el montaje sigue vivo al cambiar. */
export type Section = "montar" | "galeria" | "extraer" | "ajustes";

const SECTIONS: { id: Section; label: string; Icon: () => ReactElement }[] = [
  { id: "montar", label: "Montar ranking", Icon: RankingIcon },
  { id: "galeria", label: "Galería de videos", Icon: GalleryIcon },
  { id: "extraer", label: "Divisor de escenas", Icon: ScenesIcon },
  { id: "ajustes", label: "Configuración", Icon: SettingsIcon },
];

/**
 * Menú lateral izquierdo con las secciones del panel (RF-10 y RF-16). Se puede **retraer**
 * a una barra estrecha para dejar todo el ancho al contenido, y en pantallas estrechas se
 * pliega en un control etiquetado —nunca un icono mudo— y sigue permitiendo todas.
 */
export default function Sidebar({
  active,
  onNavigate,
  collapsed,
  onToggle,
}: {
  active: Section;
  onNavigate: (section: Section) => void;
  /** El menú está retraído a una barra: solo queda el control para volver a abrirlo. */
  collapsed: boolean;
  /** Retrae o despliega el menú. */
  onToggle: () => void;
}) {
  const [open, setOpen] = useState(false);

  // Con el menú plegado, elegir sección lo cierra: el destino ya está a la vista.
  useEffect(() => {
    setOpen(false);
  }, [active]);

  // Escape cierra el menú plegado sin sacar el foco de la página.
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open]);

  const current = SECTIONS.find((item) => item.id === active) ?? SECTIONS[0];

  if (collapsed) {
    return (
      <aside className="sidebar sidebar-rail" aria-label="Secciones del panel">
        <button
          className="sidebar-expand"
          type="button"
          onClick={onToggle}
          aria-label="Mostrar el menú lateral"
          title="Mostrar el menú lateral"
        >
          <MenuIcon />
          <span className="sidebar-expand-label">Menú</span>
        </button>
      </aside>
    );
  }

  return (
    <aside className="sidebar" aria-label="Secciones del panel">
      <div className="sidebar-brand-row">
        <div className="sidebar-brand">
          <span className="sidebar-brand-name">openRanks</span>
        </div>
        <button
          className="sidebar-collapse"
          type="button"
          onClick={onToggle}
          aria-label="Ocultar el menú lateral"
          title="Ocultar el menú lateral"
        >
          <CollapseIcon />
        </button>
      </div>

      <button
        className="sidebar-toggle"
        type="button"
        aria-expanded={open}
        aria-controls="sidebar-nav"
        onClick={() => setOpen((value) => !value)}
      >
        {open ? "Ocultar secciones" : `Secciones · ${current.label}`}
      </button>

      <nav id="sidebar-nav" className={`sidebar-nav ${open ? "open" : ""}`} aria-label="Principal">
        {SECTIONS.map((item) => (
          <button
            key={item.id}
            className={`sidebar-item ${item.id === active ? "active" : ""}`}
            type="button"
            aria-current={item.id === active ? "page" : undefined}
            onClick={() => onNavigate(item.id)}
          >
            <item.Icon />
            <span className="sidebar-item-label">{item.label}</span>
          </button>
        ))}
      </nav>
    </aside>
  );
}

/** Icono de menú para la barra retraída (trazos, sin dependencia extra). */
function MenuIcon() {
  return (
    <svg
      aria-hidden="true"
      width="20"
      height="20"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M4 6h16" />
      <path d="M4 12h16" />
      <path d="M4 18h16" />
    </svg>
  );
}

/** Trazo común de los iconos de las secciones (sin dependencia extra). */
function Icon({ children }: { children: ReactNode }) {
  return (
    <svg
      aria-hidden="true"
      className="sidebar-item-icon"
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {children}
    </svg>
  );
}

/** Montar ranking: capas apiladas, los clips en orden. */
function RankingIcon() {
  return (
    <Icon>
      <path d="M12 2 2 7l10 5 10-5-10-5z" />
      <path d="M2 17l10 5 10-5" />
      <path d="M2 12l10 5 10-5" />
    </Icon>
  );
}

/** Galería de videos: una imagen con su monte y su sol. */
function GalleryIcon() {
  return (
    <Icon>
      <rect x="3" y="3" width="18" height="18" rx="2" />
      <circle cx="8.5" cy="8.5" r="1.5" />
      <path d="M21 15l-5-5L5 21" />
    </Icon>
  );
}

/** Divisor de escenas: tijeras de corte. */
function ScenesIcon() {
  return (
    <Icon>
      <circle cx="6" cy="6" r="3" />
      <circle cx="6" cy="18" r="3" />
      <path d="M20 4 8.12 15.88" />
      <path d="M14.47 14.48 20 20" />
      <path d="M8.12 8.12 12 12" />
    </Icon>
  );
}

/** Configuración: la tuerca. */
function SettingsIcon() {
  return (
    <Icon>
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.6a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9c.14.6.62 1.05 1.24 1.24H21a2 2 0 0 1 0 4h-.09c-.62.19-1.1.64-1.24 1.24z" />
    </Icon>
  );
}

/** Icono de retraer: la flecha apunta hacia el borde del menú. */
function CollapseIcon() {
  return (
    <svg
      aria-hidden="true"
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M15 18l-6-6 6-6" />
    </svg>
  );
}
