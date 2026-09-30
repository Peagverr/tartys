// Общие помощники интерфейса: экраны-оверлеи и маршрутизация кнопок data-go.

export const $ = <T extends HTMLElement = HTMLElement>(sel: string, root: ParentNode = document): T =>
  root.querySelector<T>(sel)!;

export const esc = (s: string): string =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

export const fmtSec = (s: number): string => s.toFixed(1).replace('.', ',');

export const screen = $('#screen');

export function showScreen(html: string, clear = false): void {
  screen.innerHTML = html;
  screen.classList.add('on');
  screen.classList.toggle('clear', clear);
  screen.scrollTop = 0;
}

export function hideScreen(): void {
  screen.classList.remove('on');
  screen.innerHTML = '';
}

type Handler = (el: HTMLElement, e: Event) => void;
const routes = new Map<string, Handler>();

/** Кнопка с data-go="name" вызывает обработчик name. */
export function route(name: string, h: Handler): void {
  routes.set(name, h);
}

export function go(name: string, el: HTMLElement = document.body, e: Event = new Event('go')): void {
  routes.get(name)?.(el, e);
}

let before: (() => void) | null = null;
/** Вызывается перед каждым переходом по кнопке (звук клика и т. п.). */
export function beforeRoute(fn: () => void): void {
  before = fn;
}

screen.addEventListener('click', (e) => {
  const el = (e.target as HTMLElement).closest<HTMLElement>('[data-go]');
  if (!el || (el as HTMLButtonElement).disabled) return;
  const name = el.dataset.go!;
  if (!routes.has(name)) return;
  before?.();
  go(name, el, e);
});

// Enter в форме нажимает её основную кнопку.
screen.addEventListener('submit', (e) => {
  e.preventDefault();
  const btn = (e.target as HTMLElement).querySelector<HTMLElement>('[data-submit]');
  btn?.click();
});
