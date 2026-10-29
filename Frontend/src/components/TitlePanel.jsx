import { useEditorStore } from '../store/useEditorStore.js';
import { TITLE_STYLES, TITLE_POSITIONS, TITLE_ANIMS, TITLE_ACCENTS } from '../lib/titles.js';
import { updateTitle, removeTitle, beginTitleEdit, setTitleLive, endTitleEdit } from '../store/titleActions.js';
import * as I from './icons.jsx';

/**
 * Settings for the selected title, floating at the preview's top-left: text, style,
 * colour, position, size and animation. Typing and the size slider are one undo step each.
 */
export default function TitlePanel() {
  const item = useEditorStore((s) => s.titles.find((t) => t.id === s.selectedOverlayId));
  if (!item) return null;
  const close = () => {
    endTitleEdit();
    useEditorStore.getState().selectOverlay(null);
  };
  const seg = (active) =>
    `rounded-lg py-1 text-[11px] font-medium transition-colors ${active ? 'bg-raised text-fg shadow' : 'text-muted hover:text-fg'}`;

  return (
    <div
      className="panel fade-up absolute left-3 top-3 z-30 flex max-h-[calc(100%-96px)] w-[280px] flex-col overflow-hidden text-fg"
      onPointerDown={(e) => e.stopPropagation()}
      onClick={(e) => e.stopPropagation()}
    >
      <div className="flex items-center gap-2 border-b border-line px-4 py-2.5">
        <span className="grid h-6 w-6 place-items-center rounded-md bg-amber-500 text-[12px] text-white">
          <I.Text />
        </span>
        <h3 className="text-sm font-semibold">Title</h3>
        <button
          type="button"
          onClick={close}
          className="ml-auto grid h-7 w-7 place-items-center rounded-lg text-muted hover:bg-hover hover:text-fg"
          aria-label="Close title settings"
        >
          <I.X />
        </button>
      </div>

      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-4 py-3">
        <section>
          <Label>Text</Label>
          <textarea
            value={item.text}
            rows={2}
            onFocus={beginTitleEdit}
            onChange={(e) => setTitleLive(item.id, { text: e.target.value })}
            onBlur={endTitleEdit}
            // Keep editor shortcuts (Delete, Space, arrows) out of the text box.
            onKeyDown={(e) => e.stopPropagation()}
            className="w-full resize-none rounded-xl border border-line bg-sunken px-3 py-2 text-sm text-fg outline-none focus:border-accent"
            placeholder="Title text (Enter for a new line)"
          />
        </section>

        <section>
          <Label>Style</Label>
          <div className="grid grid-cols-2 gap-1 rounded-xl border border-line bg-sunken p-1">
            {TITLE_STYLES.map((st) => (
              <button
                key={st.id}
                type="button"
                onClick={() =>
                  item.style !== st.id &&
                  // A lower third belongs bottom-left; switching to it moves it there.
                  updateTitle(item.id, st.id === 'lower' ? { style: st.id, position: 'lower-left' } : { style: st.id })
                }
                className={seg(item.style === st.id)}
              >
                {st.name}
              </button>
            ))}
          </div>
        </section>

        <section>
          <Label>Colour</Label>
          <div className="flex gap-2">
            {TITLE_ACCENTS.map((c) => (
              <button
                key={c}
                type="button"
                aria-label={`Accent ${c}`}
                onClick={() => item.accent !== c && updateTitle(item.id, { accent: c })}
                className={`h-6 w-6 rounded-full border-2 transition-transform ${item.accent === c ? 'scale-110 border-fg' : 'border-line'}`}
                style={{ background: c }}
              />
            ))}
          </div>
          <p className="mt-1 text-[11px] text-subtle">Used by the Lower third bar and the Boxed background.</p>
        </section>

        <section>
          <Label>Position</Label>
          <div className="grid grid-cols-2 gap-1 rounded-xl border border-line bg-sunken p-1">
            {Object.entries(TITLE_POSITIONS).map(([id, p]) => (
              <button key={id} type="button" onClick={() => item.position !== id && updateTitle(item.id, { position: id })} className={seg(item.position === id)}>
                {p.label}
              </button>
            ))}
          </div>
        </section>

        <section>
          <Label value={`${Math.round(item.scale * 100)}%`}>Size</Label>
          <input
            type="range"
            min={0.5}
            max={2}
            step={0.05}
            value={item.scale}
            onPointerDown={beginTitleEdit}
            onKeyDown={beginTitleEdit}
            onChange={(e) => setTitleLive(item.id, { scale: Number(e.target.value) })}
            onPointerUp={endTitleEdit}
            onKeyUp={endTitleEdit}
            onBlur={endTitleEdit}
            className="w-full accent-[var(--c-accent)]"
            aria-label="Title size"
          />
        </section>

        <section>
          <Label>Animation</Label>
          <div className="grid grid-cols-4 gap-1 rounded-xl border border-line bg-sunken p-1">
            {TITLE_ANIMS.map((a) => (
              <button key={a.id} type="button" onClick={() => item.anim !== a.id && updateTitle(item.id, { anim: a.id })} className={seg(item.anim === a.id)}>
                {a.label}
              </button>
            ))}
          </div>
        </section>

        <div className="border-t border-line pt-3">
          <button
            type="button"
            onClick={() => removeTitle(item.id)}
            className="w-full rounded-lg border border-red-500/40 py-1.5 text-xs font-medium text-red-500 hover:bg-red-500/10 dark:text-red-300"
          >
            Remove title
          </button>
        </div>
      </div>
    </div>
  );
}

function Label({ children, value }) {
  return (
    <div className="mb-1.5 flex items-baseline justify-between text-xs font-semibold text-muted">
      <span>{children}</span>
      {value != null && <span className="font-mono tabular-nums text-subtle">{value}</span>}
    </div>
  );
}
