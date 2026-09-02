import { CircleDot, Plus, SlidersHorizontal, X } from "lucide-react";
import { queueNavigation } from "./queues";
import type { QueueCounts, SavedView } from "./types";

interface QueueSidebarProps {
  queue: string;
  counts?: QueueCounts;
  savedViews: SavedView[];
  onSelectQueue: (queue: string) => void;
  onSaveView: () => void;
  onApplyView: (view: SavedView) => void;
  onDeleteView: (viewId: string) => void;
}

export function QueueSidebar({
  queue,
  counts,
  savedViews,
  onSelectQueue,
  onSaveView,
  onApplyView,
  onDeleteView,
}: QueueSidebarProps) {
  return (
    <aside className="queue-panel">
      <div className="queue-section-label">Queues</div>
      <nav aria-label="Inbox queues">
        {queueNavigation.map(({ key, label, icon: Icon }) => (
          <button
            key={key}
            className={queue === key ? "queue-link active" : "queue-link"}
            onClick={() => onSelectQueue(key)}
          >
            <Icon size={16} />
            <span>{label}</span>
            {counts && <b>{counts[key]}</b>}
          </button>
        ))}
      </nav>
      <div className="queue-section-label saved-heading">
        <span>Saved views</span>
        <button type="button" onClick={onSaveView} aria-label="Save current view">
          <Plus size={14} />
        </button>
      </div>
      <div className="saved-view-list">
        {savedViews.length ? (
          savedViews.map((view) => (
            <div key={view.id} className="saved-view-row">
              <button onClick={() => onApplyView(view)}>
                <CircleDot size={12} />
                {view.name}
              </button>
              <button
                type="button"
                className="saved-view-remove"
                aria-label={`Delete ${view.name}`}
                onClick={() => onDeleteView(view.id)}
              >
                <X size={12} />
              </button>
            </div>
          ))
        ) : (
          <p>No saved views</p>
        )}
      </div>
      <button className="manage-views" type="button" onClick={onSaveView}>
        <SlidersHorizontal size={15} />
        Save this view
      </button>
    </aside>
  );
}
