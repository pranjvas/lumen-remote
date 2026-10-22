// Tiny DOM helpers: element builder, SVG icons, queries.

const SVG_NS = 'http://www.w3.org/2000/svg';

export function h(tag, props, ...children) {
  const el = document.createElement(tag);
  if (props) applyProps(el, props);
  append(el, children);
  return el;
}

function applyProps(el, props) {
  for (const [name, value] of Object.entries(props)) {
    if (value == null || value === false) continue;
    if (name === 'class') el.className = value;
    else if (name === 'text') el.textContent = value;
    else if (name === 'dataset') Object.assign(el.dataset, value);
    else if (name === 'style' && typeof value === 'object') {
      for (const [prop, v] of Object.entries(value)) {
        if (v == null) continue;
        if (prop.startsWith('--')) el.style.setProperty(prop, v);
        else el.style[prop] = v;
      }
    }
    else if (name === 'value') el.value = value;
    else if (name.startsWith('on') && typeof value === 'function') el.addEventListener(name.slice(2).toLowerCase(), value);
    else el.setAttribute(name, value === true ? '' : String(value));
  }
}

export function append(el, children) {
  for (const child of children.flat(Infinity)) {
    if (child == null || child === false) continue;
    el.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return el;
}

export function icon(name, cls = '') {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('class', cls ? `icon ${cls}` : 'icon');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  const use = document.createElementNS(SVG_NS, 'use');
  use.setAttribute('href', `#i-${name}`);
  svg.append(use);
  return svg;
}

export function svg(tag, attrs = {}) {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) if (v != null) el.setAttribute(k, String(v));
  return el;
}

export const $ = (sel, root = document) => root.querySelector(sel);

// replaceChildren that skips null/false like h() does (replaceChildren would print "null").
export function fill(el, ...children) {
  el.replaceChildren();
  return append(el, children);
}

export function flash(el, cls, ms = 600) {
  el.classList.remove(cls);
  void el.offsetWidth;
  el.classList.add(cls);
  setTimeout(() => el.classList.remove(cls), ms);
}

export const reducedMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
