import { useEditorStore, getSelectionSpan } from '../store/useEditorStore.js';
import { deleteOrRestoreSelection, selectionIsRemoved } from './editActions.js';
import ExportButton from './ExportButton.jsx';
import ThemeToggle from './ThemeToggle.jsx';
import * as I from './icons.jsx';
import AccountMenu from '../account/AccountMenu.jsx';
import { SaveProjectButton } from '../account/SaveControls.jsx';
import { addBrollOverSelection, canAddBroll } from '../store/overlayActions.js';
import { addTitleOverSelection, canAddTitle } from '../store/titleActions.js';

const btn =
  'inline-flex h-9 shrink-0 items-center gap-1.5 rounded-xl px-3 text-sm font-medium text-muted transition-all duration-150 hover:bg-hover hover:text-fg active:scale-95 disabled:pointer-events-none disabled:opacity-35';
/** Square icon-only button (the label lives in the tooltip). */
const iconBtn =
  'inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-[15px] text-muted transition-all duration-150 hover:bg-hover hover:text-fg active:scale-95 disabled:pointer-events-none disabled:opacity-35';
const toolBtn =
  'inline-flex h-8 shrink-0 items-center gap-1.5 rounded-lg px-2.5 text-sm font-medium text-muted transition-all duration-150 hover:bg-hover hover:text-fg active:scale-95 disabled:pointer-events-none disabled:opacity-35';

export function Logo({ size = 'text-base', compact = false }) {
  return (
    <span className={`flex shrink-0 items-center gap-2 font-bold tracking-tight ${size}`}>
      <span className="relative grid h-8 w-8 place-items-center rounded-xl bg-gradient-to-br from-scarlet-400 to-scarlet-700 text-white shadow-[0_6px_20px_-6px_var(--glow)]">
        <I.Scissors className="text-[15px]" />
      </span>
      <span className={`whitespace-nowrap ${compact ? 'hidden lg:inline' : ''}`}>
        <span className="text-accent">Scarlet</span> Rewrite
      </span>
    </span>
  );
}

function Divider() {
  return <span className="mx-1 h-5 w-px shrink-0 bg-line-strong" aria-hidden="true" />;
}

/**
 * One-line header: logo, edit tools (icon buttons; labels only where there's room), then
 * the project actions on the right. Nothing wraps; labels hide on narrower screens.
 */
export default function Toolbar() {
  const s = useEditorStore();
  const ready = s.status === 'ready';
  const hasSelection = Boolean(getSelectionSpan(s)) || Boolean(s.selectedOverlayId);
  const restoring = hasSelection && !s.selectedOverlayId && selectionIsRemoved(s);

  return (
    <header className="glass sticky top-0 z-40 flex h-14 flex-nowrap items-center gap-2 border-b border-line px-4">
      <Logo compact />

      <div className="ml-2 flex shrink-0 items-center gap-0.5 rounded-xl border border-line bg-surface p-0.5">
        <button className={iconBtn} disabled={!ready || !s.past.length} onClick={s.undo} title="Undo (Ctrl+Z)" aria-label="Undo">
          <I.Undo />
        </button>
        <button className={iconBtn} disabled={!ready || !s.future.length} onClick={s.redo} title="Redo (Ctrl+Shift+Z)" aria-label="Redo">
          <I.Redo />
        </button>
        <button
          className={`${iconBtn} ${hasSelection && !restoring ? 'text-accent hover:bg-accent-soft hover:text-accent' : ''}`}
          disabled={!ready || !hasSelection}
          onClick={deleteOrRestoreSelection}
          title={restoring ? 'Restore selection (Del)' : 'Delete selection (Del)'}
          aria-label={restoring ? 'Restore selection' : 'Delete selection'}
        >
          {restoring ? <I.Restore /> : <I.Trash />}
        </button>
        <Divider />
        <button
          className={toolBtn}
          disabled={!canAddBroll(s)}
          onClick={() => addBrollOverSelection()}
          title="Add B-roll (video or image) over the selected words"
        >
          <I.Film /> <span className="hidden xl:inline">B-roll</span>
        </button>
        <button
          className={toolBtn}
          disabled={!canAddTitle(s)}
          onClick={() => addTitleOverSelection()}
          title="Add a text title over the selected words"
        >
          <I.Text /> <span className="hidden xl:inline">Title</span>
        </button>
      </div>

      <div className="ml-auto flex shrink-0 items-center gap-1.5">
        <ThemeToggle />
        <button className={btn} onClick={s.reset} title="Open another video">
          <I.Plus /> <span className="hidden xl:inline">New</span>
        </button>
        <SaveProjectButton />
        <ExportButton />
        <AccountMenu />
      </div>
    </header>
  );
}
