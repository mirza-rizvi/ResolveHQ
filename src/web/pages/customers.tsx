import { useCallback, useEffect, useState, type FormEvent } from "react";
import { Building2, Download, Mail, Plus, Search, ShieldAlert, TicketCheck, X } from "lucide-react";
import { Link } from "react-router-dom";
import { useInfiniteQuery } from "@tanstack/react-query";
import { useAuth } from "@/web/auth";
import { useToast } from "@/web/components/toast";
import { ApiError, api, errorMessage } from "@/web/lib/api";
import { Button, Input } from "@/web/components/ui";

interface Customer {
  id: string;
  name: string;
  email: string;
  company: string | null;
  phone: string | null;
  ticketCount: number;
  lastContactedAt: string | null;
}
interface CustomerDetail {
  customer: Customer & { notes: string | null; createdAt: string };
  tickets: Array<{ id: string; number: number; subject: string; status: string; priority: string; updatedAt: string }>;
}

export function CustomersPage() {
  const { session } = useAuth();
  const toast = useToast();
  const [query, setQuery] = useState("");
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState("");
  const [detail, setDetail] = useState<CustomerDetail | null>(null);
  const [confirmingErasure, setConfirmingErasure] = useState<Customer | null>(null);
  const canManageData = session?.role === "owner" || session?.role === "admin";

  const customersQuery = useInfiniteQuery({
    queryKey: ["customers", query.trim().toLowerCase()],
    queryFn: ({ pageParam, signal }) => {
      const search = new URLSearchParams();
      if (query.trim()) search.set("q", query.trim());
      if (pageParam) search.set("cursor", pageParam);
      return api<{ customers: Customer[]; nextCursor: string | null }>(`/customers?${search}`, { signal });
    },
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (page) => page.nextCursor ?? undefined,
    placeholderData: (previous) => previous,
  });
  const customers = customersQuery.data?.pages.flatMap((page) => page.customers) ?? [];

  useEffect(() => {
    const timeout = window.setTimeout(() => void customersQuery.refetch(), 200);
    return () => window.clearTimeout(timeout);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query]);

  async function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    const form = event.currentTarget;
    try {
      await api("/customers", { method: "POST", body: JSON.stringify(Object.fromEntries(new FormData(form))) });
      form.reset();
      setCreating(false);
      await customersQuery.refetch();
    } catch (reason) {
      setError(errorMessage(reason, "Could not create customer."));
    }
  }
  async function openCustomer(id: string) {
    try {
      setDetail(await api<CustomerDetail>(`/customers/${id}`));
    } catch (reason) {
      toast.push(errorMessage(reason, "Could not open customer history."), "error");
    }
  }
  async function saveNotes(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!detail) return;
    const notes = String(new FormData(event.currentTarget).get("notes"));
    try {
      await api(`/customers/${detail.customer.id}`, { method: "PATCH", body: JSON.stringify({ notes }) });
      setDetail({ ...detail, customer: { ...detail.customer, notes } });
      toast.push("Customer notes saved.", "success");
    } catch (reason) {
      toast.push(errorMessage(reason, "Notes could not be saved."), "error");
    }
  }
  function exportCustomer(customer: Customer) {
    // Navigating to the route streams the JSON download with session cookies.
    window.location.href = `/api/privacy/customers/${customer.id}/export`;
  }
  async function eraseCustomer() {
    if (!confirmingErasure) return;
    const customer = confirmingErasure;
    setConfirmingErasure(null);
    try {
      await api(`/privacy/customers/${customer.id}/erasure`, {
        method: "POST",
        body: JSON.stringify({ acknowledge: true }),
      });
      toast.push(`Erasure queued for ${customer.name}. Their tickets are removed progressively.`, "success");
      if (detail?.customer.id === customer.id) setDetail(null);
      await customersQuery.refetch();
    } catch (reason) {
      if (reason instanceof ApiError && reason.status === 429)
        toast.push("An erasure was just requested. Try again in a moment.", "error");
      else toast.push(errorMessage(reason, "Erasure could not be queued."), "error");
    }
  }
  const searchRef = useCallback((node: HTMLInputElement | null) => node?.focus(), []);
  return (
    <div className="standard-page">
      <header className="page-header">
        <div>
          <h1>Customers</h1>
          <p>Everyone who has contacted this workspace, with their history.</p>
        </div>
        <Button onClick={() => setCreating((open) => !open)}>
          {creating ? <X size={15} /> : <Plus size={15} />}
          {creating ? "Close" : "New customer"}
        </Button>
      </header>
      {creating && (
        <form className="customer-create" onSubmit={create}>
          <Input name="name" placeholder="Full name" required />
          <Input name="email" type="email" placeholder="name@company.com" required />
          <Input name="company" placeholder="Company (optional)" />
          <Button type="submit">Save customer</Button>
          {error && <p className="form-error">{error}</p>}
        </form>
      )}
      <label className="customer-search">
        <Search size={16} />
        <Input
          ref={searchRef}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search name, email, company…"
          aria-label="Search customers"
        />
      </label>
      {customersQuery.isPending ? (
        <div className="route-loading" aria-label="Loading customers" />
      ) : customersQuery.error && !customers.length ? (
        <p className="page-error">
          {errorMessage(customersQuery.error, "Customers could not be loaded.")}{" "}
          <button type="button" onClick={() => void customersQuery.refetch()}>
            Retry
          </button>
        </p>
      ) : !customers.length ? (
        <p className="ledger-empty">No customers match. They appear here with their first conversation.</p>
      ) : (
        <div className="customer-table-wrap">
          <table className="customer-table">
            <thead>
              <tr>
                <th>Customer</th>
                <th>Company</th>
                <th>Tickets</th>
                <th>Last contact</th>
                {canManageData && <th>Data</th>}
              </tr>
            </thead>
            <tbody>
              {customers.map((customer) => (
                <tr key={customer.id}>
                  <td>
                    <button type="button" className="customer-link" onClick={() => void openCustomer(customer.id)}>
                      <strong>{customer.name}</strong>
                      <small>{customer.email}</small>
                    </button>
                  </td>
                  <td>{customer.company ?? "—"}</td>
                  <td>{customer.ticketCount}</td>
                  <td>{customer.lastContactedAt ? new Date(customer.lastContactedAt).toLocaleDateString() : "—"}</td>
                  {canManageData && (
                    <td>
                      <div className="customer-data-actions">
                        <button
                          type="button"
                          className="member-access-button"
                          title="Download everything stored about this customer"
                          onClick={() => exportCustomer(customer)}
                        >
                          <Download size={12} />
                          Export
                        </button>
                        <button
                          type="button"
                          className="member-access-button danger"
                          title="Erase this customer and their tickets"
                          onClick={() => setConfirmingErasure(customer)}
                        >
                          <ShieldAlert size={12} />
                          Erase
                        </button>
                      </div>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
          {customersQuery.hasNextPage && (
            <div className="ledger-empty">
              <Button
                variant="secondary"
                size="small"
                disabled={customersQuery.isFetchingNextPage || customersQuery.isFetching}
                onClick={() => void customersQuery.fetchNextPage({ cancelRefetch: false })}
              >
                {customersQuery.isFetchingNextPage ? "Loading more customers…" : "Load more customers"}
              </Button>
            </div>
          )}
        </div>
      )}
      {detail && (
        <section className="customer-sheet" aria-label="Customer details">
          <header>
            <div>
              <h2>{detail.customer.name}</h2>
              <p>
                <Mail size={13} /> {detail.customer.email}
                {detail.customer.company && (
                  <>
                    {" · "}
                    <Building2 size={13} /> {detail.customer.company}
                  </>
                )}
              </p>
            </div>
            <Button variant="ghost" size="icon" aria-label="Close customer details" onClick={() => setDetail(null)}>
              <X size={15} />
            </Button>
          </header>
          <div className="customer-summary">
            <span>
              <strong>
                {detail.tickets.filter((ticket) => !["resolved", "closed"].includes(ticket.status)).length}
              </strong>
              Open
            </span>
            <span>
              <strong>{detail.tickets.length}</strong>
              Total
            </span>
            <span>
              <strong>{new Date(detail.customer.createdAt).toLocaleDateString()}</strong>
              Since
            </span>
          </div>
          <ul className="customer-history">
            {detail.tickets.map((ticket) => (
              <li key={ticket.id}>
                <TicketCheck size={14} />
                <Link to={`/inbox/${ticket.id}`}>
                  #{ticket.number} {ticket.subject}
                </Link>
                <span
                  className={`badge badge-${ticket.status === "resolved" || ticket.status === "closed" ? "green" : "blue"}`}
                >
                  {ticket.status}
                </span>
              </li>
            ))}
            {!detail.tickets.length && <li>No conversations yet.</li>}
          </ul>
          <form onSubmit={saveNotes}>
            <label>
              Notes
              <textarea name="notes" defaultValue={detail.customer.notes ?? ""} rows={3} />
            </label>
            <Button type="submit" size="small">
              Save notes
            </Button>
          </form>
        </section>
      )}
      {confirmingErasure && (
        <div className="command-backdrop" role="presentation">
          <div className="erasure-dialog" role="alertdialog" aria-modal="true" aria-labelledby="erasure-title">
            <h2 id="erasure-title">Erase {confirmingErasure.name}?</h2>
            <p>
              This permanently removes the customer profile, every ticket and conversation, and the stored attachment
              files. Queued replies to them are cancelled. This cannot be undone.
            </p>
            <p className="form-error">Download an export first if anything here is still needed.</p>
            <div className="erasure-actions">
              <Button variant="secondary" size="small" onClick={() => setConfirmingErasure(null)}>
                Cancel
              </Button>
              <Button variant="danger" size="small" onClick={() => void eraseCustomer()}>
                Erase permanently
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
