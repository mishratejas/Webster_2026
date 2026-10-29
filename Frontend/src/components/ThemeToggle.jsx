import { useTheme } from '../store/useTheme.js';
import * as I from './icons.jsx';

/** Compact light / dark toggle: one icon button showing the mode you'll switch to. */
export default function ThemeToggle() {
  const theme = useTheme((s) => s.theme);
  const toggle = useTheme((s) => s.toggle);
  const dark = theme === 'dark';
  return (
    <button
      type="button"
      onClick={toggle}
      aria-label={dark ? 'Switch to light mode' : 'Switch to dark mode'}
      title={dark ? 'Light mode' : 'Dark mode'}
      className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-xl text-[16px] text-muted transition-all duration-150 hover:bg-hover hover:text-fg active:scale-95"
    >
      {dark ? <I.Sun /> : <I.Moon />}
    </button>
  );
}
