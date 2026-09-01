import { useCallback, useEffect, useState, type FormEvent } from "react";
import { Building2, Mail, Plus, Search, TicketCheck } from "lucide-react";
import { api } from "@/web/lib/api";
import { Button, Input } from "@/web/components/ui";

interface Customer { id: string; name: string; email: string; company: string | null; phone: string | null; ticketCount: number; lastContactedAt: string | null }

export function CustomersPage() {
  const [customers, setCustomers] = useState<Customer[]>([]); const [query, setQuery] = useState(""); const [creating, setCreating] = useState(false); const [error, setError] = useState("");
  const load = useCallback(async (value = query) => { const result = await api<{ customers: Customer[] }>(`/customers${value ? `?q=${encodeURIComponent(value)}` : ""}`); setCustomers(result.customers); }, [query]);
  useEffect(() => { const timeout = window.setTimeout(() => void load(query), 200); return () => window.clearTimeout(timeout); }, [load, query]);
  async function create(event: FormEvent<HTMLFormElement>) { event.preventDefault(); setError(""); const form = event.currentTarget; try { await api("/customers", { method: "POST", body: JSON.stringify(Object.fromEntries(new FormData(form))) }); form.reset(); setCreating(false); await load(""); } catch (reason) { setError(reason instanceof Error ? reason.message : "Could not create customer."); } }
  return <div className="standard-page"><header className="page-header"><div><h1>Customers</h1><p>People, companies, and the full history behind each conversation.</p></div><Button onClick={() => setCreating((value) => !value)}><Plus size={16} />Add customer</Button></header>
    {creating && <form className="inline-create" onSubmit={create}><div><label>Name<Input name="name" required /></label><label>Email<Input name="email" type="email" required /></label><label>Company<Input name="company" /></label></div>{error && <p className="form-error">{error}</p>}<footer><Button type="button" variant="ghost" onClick={() => setCreating(false)}>Cancel</Button><Button type="submit">Create customer</Button></footer></form>}
    <label className="page-search"><Search size={16} /><input placeholder="Search customers" value={query} onChange={(event) => setQuery(event.target.value)} /></label>
    <div className="customer-ledger"><div className="customer-ledger-head"><span>Customer</span><span>Company</span><span>Last contacted</span><span>Tickets</span></div>{customers.map((customer) => <article key={customer.id}><div className="customer-identity"><span>{customer.name.slice(0, 1)}</span><div><strong>{customer.name}</strong><small><Mail size={12} />{customer.email}</small></div></div><div>{customer.company ? <><Building2 size={14} />{customer.company}</> : <em>Independent</em>}</div><time>{customer.lastContactedAt ? new Date(customer.lastContactedAt).toLocaleDateString() : "No contact yet"}</time><div><TicketCheck size={14} />{customer.ticketCount}</div></article>)}</div>
  </div>;
}
