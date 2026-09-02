import { type FormEvent } from "react";
import { X } from "lucide-react";
import { Button } from "@/web/components/ui";
import { useDialogFocus } from "@/web/hooks/use-dialog-focus";
import type { CustomerOption } from "./types";

interface CreateTicketDialogProps {
  customers: CustomerOption[];
  error: string;
  submitting?: boolean;
  onClose: () => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
}

export function CreateTicketDialog({
  customers,
  error,
  submitting = false,
  onClose,
  onSubmit,
}: CreateTicketDialogProps) {
  const dialogRef = useDialogFocus<HTMLFormElement>(true, onClose);
  return (
    <div
      className="dialog-backdrop"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <form
        ref={dialogRef}
        className="dialog-card"
        role="dialog"
        aria-modal="true"
        aria-label="Create ticket"
        onSubmit={onSubmit}
      >
        <header>
          <div>
            <h2>Create ticket</h2>
            <p>Start a customer conversation.</p>
          </div>
          <button type="button" onClick={onClose} aria-label="Close">
            <X size={18} />
          </button>
        </header>
        <label>
          Customer
          <select name="customerId" required defaultValue="">
            <option value="" disabled>
              Select a customer
            </option>
            {customers.map((customer) => (
              <option key={customer.id} value={customer.id}>
                {customer.name} · {customer.email}
              </option>
            ))}
          </select>
        </label>
        <label>
          Subject
          <input name="subject" maxLength={240} required />
        </label>
        <label>
          Initial message
          <textarea name="message" rows={5} required />
        </label>
        <label>
          Priority
          <select name="priority" defaultValue="normal">
            <option value="low">Low</option>
            <option value="normal">Normal</option>
            <option value="high">High</option>
            <option value="urgent">Urgent</option>
          </select>
        </label>
        {error && (
          <p className="dialog-error" role="alert">
            {error}
          </p>
        )}
        <footer>
          <Button type="button" variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" disabled={submitting}>
            Create ticket
          </Button>
        </footer>
      </form>
    </div>
  );
}
