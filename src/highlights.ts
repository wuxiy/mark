import type { Annotation } from './api';

type Position = { node: Text; start: number; end: number };
type Registry = { set: (name: string, value: unknown) => void; delete: (name: string) => void };

export function paintHighlights(article: HTMLElement, overlay: HTMLElement, annotations: Annotation[]): () => void {
  const registry = (CSS as unknown as { highlights?: Registry }).highlights;
  const HighlightClass = (window as unknown as { Highlight?: new (...ranges: Range[]) => unknown }).Highlight;

  let text = '';
  const positions: Position[] = [];
  const walker = document.createTreeWalker(article, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const value = node.textContent ?? '';
    for (let index = 0; index < value.length; index++) {
      const character = /\s/.test(value[index]) ? ' ' : value[index];
      if (character === ' ' && text.endsWith(' ')) continue;
      text += character;
      positions.push({ node: node as Text, start: index, end: index + 1 });
    }
  }

  const ranges = new Map<Annotation['color'], Range[]>();
  for (const mark of annotations) {
    if (mark.anchorStatus === 'needs_review') continue;
    const exact = mark.exact.replace(/\s+/g, ' ').trim();
    if (!exact) continue;
    const candidates: number[] = [];
    for (let index = text.indexOf(exact); index >= 0; index = text.indexOf(exact, index + exact.length)) candidates.push(index);
    const matches = candidates.filter((index) =>
      (!mark.prefix || text.slice(Math.max(0, index - mark.prefix.length), index) === mark.prefix) &&
      (!mark.suffix || text.slice(index + exact.length, index + exact.length + mark.suffix.length) === mark.suffix));
    const selected = matches.length === 1 ? matches[0] : candidates.length === 1 ? candidates[0] : -1;
    if (selected < 0) continue;
    const first = positions[selected];
    const last = positions[selected + exact.length - 1];
    if (!first || !last) continue;
    const range = document.createRange();
    range.setStart(first.node, first.start);
    range.setEnd(last.node, last.end);
    ranges.set(mark.color, [...(ranges.get(mark.color) ?? []), range]);
  }
  const names: string[] = [];
  for (const [color, items] of ranges) {
    const name = `mark-${color}`;
    if (registry && HighlightClass) {
      registry.set(name, new HighlightClass(...items));
      names.push(name);
    } else {
      const container = overlay.getBoundingClientRect();
      for (const range of items) {
        for (const rect of range.getClientRects()) {
          if (rect.width < 1 || rect.height < 1) continue;
          const box = document.createElement('span');
          box.className = `highlight-box ${color}`;
          box.style.left = `${rect.left - container.left}px`;
          box.style.top = `${rect.top - container.top}px`;
          box.style.width = `${rect.width}px`;
          box.style.height = `${rect.height}px`;
          overlay.append(box);
        }
      }
    }
  }
  return () => { names.forEach((name) => registry?.delete(name)); overlay.replaceChildren(); };
}
