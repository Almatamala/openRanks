"use client";

import { useEffect, useState } from "react";

/** Secciones del panel. La navegación no usa rutas: el montaje sigue vivo al cambiar. */
export type Section = "montar" | "galeria";

const SECTIONS: { id: Section; label: string; note: string }[] = [
  { id: "montar", label: "Montar ranking", note: "Clips, textos y montaje" },
  { id: "galeria", label: "Galería de videos", note: "Tus clips, con categoría" },
];

/**
 * Menú lateral izquierdo con las dos secciones (RF-10). Se puede **retraer** a una
 * barra estrecha para dejar todo el ancho al contenido, y en pantallas estrechas se
 * pliega en un control etiquetado —nunca un icono mudo— y sigue permitiendo las dos.
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
          <span className="sidebar-brand-note">Montaje de rankings</span>
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
            <span className="sidebar-item-label">{item.label}</span>
            <span className="sidebar-item-note">{item.note}</span>
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
