import { Plus, Search, SlidersHorizontal } from "lucide-react";
import { Link } from "react-router-dom";
import { Button } from "@/web/components/ui";
import { relativeTime } from "./format";
import { queueLabel, queueNavigation } from "./queues";
import type { TicketSummary } from "./types";

interface TicketLedgerProps {
  tickets: TicketSummary[];
  ticketId?: string;
  queue: string;
  params: URLSearchParams;
  loading: boolean;
  error: string;
  query: string;
  onQueryChange: (value: string) => void;
  searchInputRef: React.RefObject<HTMLInputElement | null>;
  priority: string;
  onPriorityChange: (value: string) => void;
  selectedTickets: string[];
  onToggleSelected: (ticketId: string, selected: boolean) => void;
  onClearSelection: () => void;
  onBulkStatus: (status: string) => void;
  onSelectQueue: (queue: string) => void;
  onCreateTicket: () => void;
}

export function TicketLedger({
  tickets, ticketId, queue, params, loading, error, query, onQueryChange, searchInputRef,
  priority, onPriorityChange, selectedTickets, onToggleSelected, onClearSelection, onBulkStatus,
  onSelectQueue, onCreateTicket,
}: TicketLedgerProps) {
  return <section className="ticket-ledger" aria-label="Ticket rundown">
    <header className="rundown-header">
      <div className="queue-mobile-title">
        <strong>{queueLabel(queue)}</strong>
        <select aria-label="Select queue" value={queue} onChange={(event) => onSelectQueue(event.target.value)}>
          {queueNavigation.map(({ key, label }) => <option key={key} value={key}>{label}</option>)}
        </select>
      </div>
      <div className="rundown-title">
        <h1>Inbox</h1>
        <span>{tickets.length} in {queueLabel(queue)}</span>
      </div>
      <Button size="small" onClick={onCreateTicket}><Plus size={14} />New ticket</Button>
    </header>
    <div className="rundown-toolbar">
      {selectedTickets.length
        ? <div className="bulk-toolbar">
          <strong>{selectedTickets.length} selected</strong>
          <select aria-label="Bulk status" defaultValue="" onChange={(event) => { if (event.target.value) onBulkStatus(event.target.value); }}>
            <option value="">Set status…</option>
            <option value="open">Open</option>
            <option value="pending">Pending</option>
            <option value="waiting_customer">Waiting</option>
            <option value="resolved">Resolved</option>
            <option value="closed">Closed</option>
          </select>
          <button onClick={onClearSelection}>Clear</button>
        </div>
        : <label className="search-field">
          <Search size={16} />
          <input ref={searchInputRef} value={query} onChange={(event) => onQueryChange(event.target.value)} placeholder="Search tickets" aria-label="Search tickets" />
          <kbd>/</kbd>
        </label>}
      <label className="filter-control">
        <SlidersHorizontal size={15} />
        <span className="sr-only">Filter by priority</span>
        <select aria-label="Filter by priority" value={priority} onChange={(event) => onPriorityChange(event.target.value)}>
          <option value="">All priorities</option>
          <option value="urgent">Urgent</option>
          <option value="high">High</option>
          <option value="normal">Normal</option>
          <option value="low">Low</option>
        </select>
      </label>
    </div>
    <div className="ticket-table-wrap">
      {loading
        ? <LedgerSkeleton />
        : error
          ? <EmptyLedger title="Queue unavailable" detail={error} />
          : tickets.length === 0
            ? <EmptyLedger title="Queue clear" detail="New conversations will appear here automatically." />
            : <table className="ticket-table">
              <thead>
                <tr>
                  <th><span className="sr-only">Select</span></th>
                  <th>ID</th><th>Priority</th><th>Subject</th><th>Customer</th><th>Assignee</th><th>Updated</th>
                </tr>
              </thead>
              <tbody>
                {tickets.map((ticket) => <tr key={ticket.id} className={ticket.id === ticketId ? "selected" : ""}>
                  <td>
                    <input
                      type="checkbox"
                      aria-label={`Select ticket ${ticket.number}`}
                      checked={selectedTickets.includes(ticket.id)}
                      onChange={(event) => onToggleSelected(ticket.id, event.target.checked)}
                    />
                  </td>
                  <td><span className="ticket-id">#{ticket.number}</span>{ticket.unread && <i className="unread-dot" aria-label="Unread" />}</td>
                  <td><Priority value={ticket.priority} /></td>
                  <td><Link className="ticket-subject-link" to={`/inbox/${ticket.id}?${params}`}>{ticket.subject}</Link></td>
                  <td>{ticket.customerName}</td>
                  <td><span className={ticket.assigneeName ? "assignee-label" : "assignee-label unassigned"}>{ticket.assigneeName ?? "Unassigned"}</span></td>
                  <td><time>{relativeTime(ticket.updatedAt)}</time></td>
                </tr>)}
              </tbody>
            </table>}
    </div>
  </section>;
}

function Priority({ value }: { value: string }) {
  return <span className={`priority priority-${value}`}><i />{value}</span>;
}

function LedgerSkeleton() {
  return <div className="ledger-skeleton" aria-label="Loading tickets"><span /><span /><span /><span /></div>;
}

function EmptyLedger({ title, detail }: { title: string; detail: string }) {
  return <div className="empty-ledger"><h2>{title}</h2><p>{detail}</p></div>;
}
