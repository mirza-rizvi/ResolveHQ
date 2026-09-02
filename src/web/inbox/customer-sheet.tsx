import { X } from "lucide-react";
import { Link } from "react-router-dom";
import { useDialogFocus } from "@/web/hooks/use-dialog-focus";
import type { CustomerDetail } from "./types";

export function CustomerSheet({ detail, onClose }: { detail: CustomerDetail; onClose: () => void }) {
  const sheetRef = useDialogFocus<HTMLElement>(true, onClose);
  return <div className="sheet-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <aside ref={sheetRef} className="customer-sheet" role="dialog" aria-modal="true" aria-label="Customer details">
      <header>
        <div><span>Customer</span><h2>{detail.customer.name}</h2></div>
        <button type="button" onClick={onClose} aria-label="Close customer details"><X size={18} /></button>
      </header>
      <dl>
        <div><dt>Email</dt><dd>{detail.customer.email}</dd></div>
        <div><dt>Company</dt><dd>{detail.customer.company ?? "—"}</dd></div>
        <div><dt>Phone</dt><dd>{detail.customer.phone ?? "—"}</dd></div>
        <div><dt>Customer since</dt><dd>{new Date(detail.customer.createdAt).toLocaleDateString()}</dd></div>
      </dl>
      {detail.customer.notes && <section><h3>Team notes</h3><p>{detail.customer.notes}</p></section>}
      <section>
        <h3>Ticket history</h3>
        {detail.tickets.map((item) => <Link key={item.id} to={`/inbox/${item.id}`} onClick={onClose}>
          <span>#{item.number}</span>
          <strong>{item.subject}</strong>
          <time>{new Date(item.updatedAt).toLocaleDateString()}</time>
        </Link>)}
      </section>
    </aside>
  </div>;
}
