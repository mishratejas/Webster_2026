import { useEditorStore } from './store/useEditorStore.js';
import './store/useTheme.js';
import UploadPanel from './components/UploadPanel.jsx';
import Toolbar from './components/Toolbar.jsx';
import StatusBar from './components/StatusBar.jsx';
import VideoPreview from './components/VideoPreview.jsx';
import Timeline from './components/Timeline.jsx';
import TranscriptEditor, { useTranscriptShortcuts } from './components/TranscriptEditor.jsx';
import TranscriptPanel from './components/TranscriptPanel.jsx';

export default function App() {
  const videoUrl = useEditorStore((s) => s.videoUrl);
  if (!videoUrl) return <UploadPanel />;
  return <Editor />;
}

function Editor() {
  useTranscriptShortcuts();

  return (
    <div className="ambient flex h-full flex-col">
      <Toolbar />
      <main className="grid min-h-0 flex-1 gap-4 overflow-y-auto p-4 lg:overflow-hidden lg:grid-cols-[minmax(0,1.9fr)_minmax(300px,1fr)]">
        <section className="fade-up flex min-h-[520px] min-w-0 flex-col gap-4 lg:min-h-0">
          <VideoPreview />
          <StatusBar />
          <Timeline />
        </section>
        <TranscriptPanel>
          <TranscriptEditor />
        </TranscriptPanel>
      </main>
    </div>
  );
}