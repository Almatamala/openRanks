"use client";

import { useEffect, useId, useMemo, useRef, useState, type FocusEvent, type KeyboardEvent } from "react";

import { categoryKey } from "@/lib/gallery";

/**
 * Selector de categoría con búsqueda (RF-11.3).
 *
 * Un `datalist` nativo solo enseña sugerencias del navegador; aquí la lista es la de
 * **todas** las categorías que ya usa la galería y se filtra a medida que se escribe. Se
 * puede elegir una existente (clic o flechas + Enter) o escribir una nueva: la lista nunca
 * obliga a nada.
 */
export default function CategoryPicker({
  id,
  value,
  categories,
  onChange,
  placeholder = "Sin categoría",
  ariaLabel,
  disabled = false,
  removeLabel,
  onSubmit,
  onCancel,
}: {
  /** Id del campo, para que la etiqueta de fuera lo apunte. */
  id?: string;
  value: string;
  /** Categorías existentes, tal y como las devuelve la galería. */
  categories: string[];
  onChange: (value: string) => void;
  placeholder?: string;
  ariaLabel?: string;
  disabled?: boolean;
  /** Texto de la opción que deja los clips sin categoría; sin él no se ofrece. */
  removeLabel?: string;
  /** Enter sin una opción resaltada: lo que haga el formulario que lo contiene. */
  onSubmit?: () => void;
  /** Escape con la lista cerrada. */
  onCancel?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const box = useRef<HTMLDivElement | null>(null);
  const listId = useId();

  // La lista enseña las que coinciden con lo escrito, sin distinguir mayúsculas ni acentos
  // de más: se compara con la misma clave que el filtro de la galería.
  const matches = useMemo(() => {
    const key = categoryKey(value);
    return categories.filter((category) => categoryKey(category).includes(key));
  }, [categories, value]);

  const options = useMemo(() => {
    const rows = matches.map((category) => ({ label: category, value: category, empty: false }));
    // «Sin categoría» solo tiene sentido cuando no se está buscando nada.
    if (removeLabel && value.trim() === "") {
      rows.unshift({ label: removeLabel, value: "", empty: true });
    }
    return rows;
  }, [matches, removeLabel, value]);

  // Al cerrar se suelta la opción resaltada: la próxima flecha empieza por arriba.
  useEffect(() => {
    if (!open) setActive(-1);
  }, [open]);

  const choose = (next: string) => {
    onChange(next);
    setOpen(false);
    setActive(-1);
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      setOpen(true);
      if (options.length === 0) return;
      const step = event.key === "ArrowDown" ? 1 : -1;
      setActive((current) => {
        const next = current + step;
        if (next < 0) return options.length - 1;
        return next >= options.length ? 0 : next;
      });
      return;
    }
    if (event.key === "Enter") {
      if (open && active >= 0 && options[active]) {
        event.preventDefault();
        choose(options[active].value);
        return;
      }
      // Sin opción resaltada, Enter es el del formulario: subir o guardar.
      onSubmit?.();
      return;
    }
    if (event.key === "Escape") {
      if (open) {
        event.preventDefault();
        setOpen(false);
        return;
      }
      onCancel?.();
    }
  };

  // Solo se cierra cuando el foco sale del componente: pulsar una opción no lo pierde.
  const handleBlur = (event: FocusEvent<HTMLDivElement>) => {
    const next = event.relatedTarget;
    if (next instanceof Node && box.current?.contains(next)) return;
    setOpen(false);
  };

  return (
    <div className="category-picker" ref={box} onBlur={handleBlur}>
      <input
        id={id}
        type="text"
        role="combobox"
        aria-expanded={open}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={open && active >= 0 ? `${listId}-${active}` : undefined}
        aria-label={ariaLabel}
        autoComplete="off"
        spellCheck={false}
        placeholder={placeholder}
        value={value}
        disabled={disabled}
        onChange={(event) => {
          onChange(event.target.value);
          setOpen(true);
        }}
        onClick={() => setOpen(true)}
        onFocus={() => setOpen(true)}
        onKeyDown={handleKeyDown}
      />
      {open && options.length > 0 ? (
        <ul className="category-picker-list" id={listId} role="listbox" aria-label="Categorías">
          {options.map((option, index) => (
            <li role="presentation" key={option.empty ? "__sin_categoria__" : option.value}>
              <button
                id={`${listId}-${index}`}
                className={`category-option${index === active ? " active" : ""}${
                  option.empty ? " empty" : ""
                }`}
                type="button"
                role="option"
                aria-selected={option.value === value}
                tabIndex={-1}
                onMouseDown={(event) => event.preventDefault()}
                onMouseEnter={() => setActive(index)}
                onClick={() => choose(option.value)}
              >
                {option.label}
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
