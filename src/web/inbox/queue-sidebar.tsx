import { CircleDot, Plus, SlidersHorizontal } from "lucide-react";
import { queueNavigation } from "./queues";
import type { SavedView } from "./types";

interface QueueSidebarProps {
  queue: string;
  ticketCount: number;
  savedViews: SavedView[];
  onSelectQueue: (queue: string) => void;
  onSaveView: () => void;
  onApplyView: (view: SavedView) => void;
}

export function QueueSidebar({ queue, ticketCount, savedViews, onSelectQueue, onSaveView, onApplyView }: QueueSidebarProps) {
  return <aside className="queue-panel">
    <div className="queue-section-label">Queues</div>
    <nav aria-label="Inbox queues">
      {queueNavigation.map(({ key, label, icon: Icon }) => <button
        key={key}
        className={queue === key ? "queue-link active" : "queue-link"}
        onClick={() => onSelectQueue(key)}
      >
        <Icon size={16} /><span>{label}</span>{queue === key && <b>{ticketCount}</b>}
      </button>)}
    </nav>
    <div className="queue-section-label saved-heading">
      <span>Saved views</span>
      <button type="button" onClick={onSaveView} aria-label="Save current view"><Plus size={14} /></button>
    </div>
    <div className="saved-view-list">
      {savedViews.length
        ? savedViews.map((view) => <button key={view.id} onClick={() => onApplyView(view)}><CircleDot size={12} />{view.name}</button>)
        : <p>No saved views</p>}
    </div>
    <button className="manage-views" type="button" onClick={onSaveView}><SlidersHorizontal size={15} />Save this view</button>
  </aside>;
}
