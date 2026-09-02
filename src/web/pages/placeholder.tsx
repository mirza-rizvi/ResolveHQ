import { ArrowLeft, Construction } from "lucide-react";
import { Link } from "react-router-dom";
export function PlaceholderPage({ title, description }: { title: string; description: string }) {
  return (
    <div className="placeholder-page">
      <Construction size={24} />
      <h1>{title}</h1>
      <p>{description}</p>
      <span>This area is intentionally reserved for a later product phase.</span>
      <Link to="/inbox">
        <ArrowLeft size={15} />
        Return to inbox
      </Link>
    </div>
  );
}
