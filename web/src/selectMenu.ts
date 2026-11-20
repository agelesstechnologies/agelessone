/**
 * Drop-down lists that always fit the screen.
 * The browser draws a native <select> list outside the page, so it can be bigger than the pop-up
 * or run off a phone or tablet screen. This replaces that list with a menu drawn inside the page,
 * kept within the viewport. The real <select> stays in place: we set its value and fire a normal
 * "change" event, so forms (FormData, defaultValue, React onChange) work unchanged.
 * Installed once from main.tsx; call sites need no change.
 */
type Row = { el: HTMLElement; option: HTMLOptionElement };

let menu: HTMLDivElement | null = null;
let owner: HTMLSelectElement | null = null;
let rows: Row[] = [];
let active = -1;

const usable = (s: Element | null): s is HTMLSelectElement =>
  !!s && s instanceof HTMLSelectElement && !s.multiple && s.size <= 1 && !s.disabled;

function close(refocus = false) {
  if (!menu) return;
  menu.remove();
  menu = null;
  rows = [];
  active = -1;
  const s = owner;
  owner = null;
  s?.setAttribute('aria-expanded', 'false');
  if (refocus) s?.focus({ preventScroll: true });
}

function mark(i: number, scroll = true) {
  rows.forEach((r, n) => r.el.classList.toggle('active', n === i));
  active = i;
  if (scroll) rows[i]?.el.scrollIntoView({ block: 'nearest' });
}

function pick(option: HTMLOptionElement) {
  const s = owner;
  if (!s || option.disabled) return;
  const changed = s.value !== option.value;
  s.value = option.value;
  close(true);
  if (changed) {
    s.dispatchEvent(new Event('input', { bubbles: true }));
    s.dispatchEvent(new Event('change', { bubbles: true }));
  }
}

function place(s: HTMLSelectElement, m: HTMLDivElement) {
  const gap = 8;
  const vw = document.documentElement.clientWidth;
  const vh = window.innerHeight;
  const r = s.getBoundingClientRect();
  const width = Math.min(Math.max(r.width, 160), vw - gap * 2);
  const left = Math.max(gap, Math.min(r.left, vw - width - gap));
  m.style.width = `${width}px`;
  m.style.left = `${left}px`;
  m.style.maxHeight = 'none';
  const natural = m.scrollHeight;
  const below = vh - r.bottom - gap - 4;
  const above = r.top - gap - 4;
  const openUp = natural > below && above > below;
  const room = Math.max(120, Math.min(openUp ? above : below, 320));
  m.style.maxHeight = `${room}px`;
  const h = Math.min(natural, room);
  m.style.top = `${openUp ? Math.max(gap, r.top - h - 4) : r.bottom + 4}px`;
}

function rowAt(target: EventTarget | null): number {
  const hit = target instanceof Element ? target.closest('.sel-opt') : null;
  return rows.findIndex((r) => r.el === hit);
}

function open(s: HTMLSelectElement) {
  close();
  owner = s;
  s.setAttribute('aria-haspopup', 'listbox');
  s.setAttribute('aria-expanded', 'true');
  const m = document.createElement('div');
  m.className = 'sel-menu';
  m.setAttribute('role', 'listbox');
  const add = (o: HTMLOptionElement, indent: boolean) => {
    const el = document.createElement('div');
    el.className = 'sel-opt' + (indent ? ' in-group' : '') + (o.disabled ? ' disabled' : '') + (o.selected ? ' selected' : '');
    el.setAttribute('role', 'option');
    el.setAttribute('aria-selected', String(o.selected));
    el.textContent = o.text || ' ';
    m.appendChild(el);
    rows.push({ el, option: o });
  };
  Array.from(s.children).forEach((c) => {
    if (c instanceof HTMLOptGroupElement) {
      const g = document.createElement('div');
      g.className = 'sel-group';
      g.textContent = c.label;
      m.appendChild(g);
      Array.from(c.children).forEach((o) => { if (o instanceof HTMLOptionElement) add(o, true); });
    } else if (c instanceof HTMLOptionElement) add(c, false);
  });
  m.addEventListener('mousedown', (e) => e.preventDefault()); // keep focus on the field
  m.addEventListener('click', (e) => {
    const row = rows[rowAt(e.target)];
    if (row) pick(row.option);
  });
  m.addEventListener('mousemove', (e) => {
    const i = rowAt(e.target);
    if (i >= 0 && !rows[i].el.classList.contains('disabled')) mark(i, false);
  });
  document.body.appendChild(m);
  menu = m;
  place(s, m);
  mark(Math.max(0, rows.findIndex((r) => r.option.selected)));
}

function step(dir: 1 | -1, from = active) {
  let i = from;
  for (let n = 0; n < rows.length; n++) {
    i = (i + dir + rows.length) % rows.length;
    if (!rows[i].el.classList.contains('disabled')) { mark(i); return; }
  }
}

export function installSelectMenu() {
  const flag = document as unknown as { __selMenu?: boolean };
  if (flag.__selMenu) return;
  flag.__selMenu = true;

  document.addEventListener('mousedown', (e) => {
    const t = e.target instanceof Element ? e.target : null;
    if (menu && t && menu.contains(t)) return;
    const s = t ? t.closest('select') : null;
    if (usable(s)) {
      e.preventDefault(); // no native list
      s.focus({ preventScroll: true });
      if (owner === s) close(); else open(s);
      return;
    }
    if (menu) {
      close();
      // the click that follows only dismisses the menu (like a native list); it does not press what is under it
      const swallow = (ev: Event) => { ev.stopPropagation(); ev.preventDefault(); };
      document.addEventListener('click', swallow, { capture: true, once: true });
      setTimeout(() => document.removeEventListener('click', swallow, true), 400);
    }
  }, true);

  document.addEventListener('keydown', (e) => {
    const t = e.target instanceof Element ? e.target : null;
    if (menu) {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(true); }
      else if (e.key === 'ArrowDown') { e.preventDefault(); step(1); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); step(-1); }
      else if (e.key === 'Home') { e.preventDefault(); step(1, -1); }
      else if (e.key === 'End') { e.preventDefault(); step(-1, 0); }
      else if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); const o = rows[active]?.option; if (o) pick(o); }
      else if (e.key === 'Tab') close();
      return;
    }
    if (usable(t) && (e.key === ' ' || (e.key === 'ArrowDown' && e.altKey))) { e.preventDefault(); open(t); }
  }, true);

  window.addEventListener('resize', () => close());
  window.addEventListener('orientationchange', () => close());
  // scrolling the page moves the field away from the menu, so close it (scrolling inside the menu is fine)
  document.addEventListener('scroll', (e) => { if (menu && !(e.target instanceof Node && menu.contains(e.target))) close(); }, true);
}
