import { useEditorStore, getSelectionSpan } from '../store/useEditorStore.js';
import { editedDuration } from '../lib/edl.js';
import { formatTime } from '../lib/transcript.js';
import { deleteOrRestoreSelection, selectionIsRemoved } from './editActions.js';
import ExportButton from './ExportButton.jsx';
import ThemeToggle from './ThemeToggle.jsx';
import * as I from './icons.jsx';
import AccountMenu from '../account/AccountMenu.jsx';
import { SaveProjectButton } from '../account/SaveControls.jsx';
import { addBrollOverSelection, canAddBroll } from '../store/overlayActions.js';
import { addTitleOverSelection, canAddTitle } from '../store/titleActions.js';

const btn =
  'inline-flex h-9 items-center gap-1.5 rounded-xl px-3 text-sm font-medium text-muted transition-all duration-150 hover:bg-hover hover:text-fg active:scale-95 disabled:pointer-events-none disabled:opacity-35';

export function Logo({ size = 'text-base' }) {
  return (
    <span className={`flex items-center gap-2 font-bold tracking-tight ${size}`}>
      <span className="relative grid h-8 w-8 place-items-center rounded-xl bg-gradient-to-br from-scarlet-400 to-scarlet-700 text-white shadow-[0_6px_20px_-6px_var(--glow)]">
        <I.Scissors className="text-[15px]" />
      </span>
      <span>
        <span className="text-accent">Scarlet</span> Rewrite
      </span>
    </span>
  );
}

export default function Toolbar() {
  const s = useEditorStore();
  const ready = s.status === 'ready';
  const hasSelection = Boolean(getSelectionSpan(s));
  const restoring = hasSelection && selectionIsRemoved(s);
  const edited = editedDuration(s.removedRanges, s.duration);
  const saved = s.duration - edited;

  return (
    <header className="glass sticky top-0 z-40 flex flex-wrap items-center gap-1 border-b border-line px-4 py-2">
      <div className="mr-4">
        <Logo />
      </div>

      <div className="flex items-center gap-0.5 rounded-2xl border border-line bg-surface p-0.5">
        <button className={btn} disabled={!ready || !s.past.length} onClick={s.undo} title="Undo (Ctrl+Z)">
          <I.Undo /> <span className="hidden md:inline">Undo</span>
        </button>
        <button className={btn} disabled={!ready || !s.future.length} onClick={s.redo} title="Redo (Ctrl+Shift+Z)">
          <I.Redo /> <span className="hidden md:inline">Redo</span>
        </button>
        <button
          className={`${btn} ${hasSelection && !restoring ? 'text-accent hover:bg-accent-soft hover:text-accent' : ''}`}
          disabled={!ready || !hasSelection}
          onClick={deleteOrRestoreSelection}
          title="Delete / restore selection (Del)"
        >
          {restoring ? <I.Restore /> : <I.Trash />} <span className="hidden md:inline">{restoring ? 'Restore' : 'Delete'}</span>
        </button>
        <button
          className={btn}
          disabled={!canAddBroll(s)}
          onClick={() => addBrollOverSelection()}
          title="Add B-roll (video or image) over the selected words"
        >
          <I.Film /> <span className="hidden md:inline">B-roll</span>
        </button>
        <button
          className={btn}
          disabled={!canAddTitle(s)}
          onClick={() => addTitleOverSelection()}
          title="Add a text title over the selected words"
        >
          <I.Text /> <span className="hidden md:inline">Title</span>
        </button>
      </div>

      <div className="ml-auto flex items-center gap-2 text-sm">
        {s.device && (
          <span className="hidden items-center gap-1.5 rounded-full border border-line px-2.5 py-1 text-xs text-muted lg:flex">
            <I.Cpu /> Whisper · {s.device === 'webgpu' ? 'WebGPU' : 'WASM'}
          </span>
        )}
        {s.duration > 0 && (
          <span
            className="hidden items-center gap-2 rounded-full border border-line px-3 py-1 font-mono text-xs tabular-nums sm:flex"
            title="Edited length / original length"
          >
            <span className="text-fg">{formatTime(edited)}</span>
            <span className="text-subtle">/ {formatTime(s.duration)}</span>
            {saved > 0.05 && <span className="rounded-full bg-accent-soft px-1.5 text-accent">−{saved.toFixed(1)}s</span>}
          </span>
        )}
        <ThemeToggle />
        <button className={btn} onClick={s.reset} title="Open another video">
          <I.Plus /> <span className="hidden md:inline">New</span>
        </button>
        <SaveProjectButton />
        <ExportButton />
        <AccountMenu />
      </div>
    </header>
  );
}