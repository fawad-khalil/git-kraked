interface Props {
  width: number;
  /** 1 when dragging right widens the pane (a left pane), -1 when dragging left does. */
  direction: 1 | -1;
  min: number;
  max: number;
  onResize: (width: number) => void;
}

/** A vertical strip between two panes that drags to resize one of them. */
export function PaneResizer({ width, direction, min, max, onResize }: Props) {
  function start(e: React.PointerEvent) {
    e.preventDefault();
    const x0 = e.clientX;
    const move = (m: PointerEvent) =>
      onResize(Math.min(max, Math.max(min, Math.round(width + direction * (m.clientX - x0)))));
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      document.body.classList.remove("resizing");
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    document.body.classList.add("resizing");
  }
  return <div className="pane-resizer" role="separator" aria-orientation="vertical" title="Drag to resize" onPointerDown={start} />;
}
